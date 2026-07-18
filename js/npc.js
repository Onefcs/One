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
function _craftsmanBody() {
  const p = player;
  let html = `<div class="shop-gold">${iconHTML('coin',16,'#f1c40f')} Золото: <b>${p.gold}</b></div>`;
  html += '<div class="shop-sec">Рецепты крафта</div>';
  html += '<div class="craft-mats-info">Материалы в инвентаре: ' + _listMats() + '</div>';
  html += '<div class="shop-list">';
  CRAFT_RECIPES.forEach((recipe, idx) => {
    const result = ITEM_DEF.find(i => i.id === recipe.resultId);
    if (!result) return;
    const rc = RARITY_COLOR[result.rarity] || '#aaa';
    const canCraft = _canCraft(recipe) && p.gold >= recipe.gold && p.inventory.length < 50;
    const stats = statStr(result);
    html += `<div class="shop-row craft-row-clickable${canCraft ? ' craft-can' : ''}" onclick="openCraftModal(${idx})">
      <span class="shop-item-icon">${_itemIcon(result, 28)}</span>
      <div class="shop-item-info">
        <div class="shop-item-name" style="color:${rc}">${result.name}</div>
        <div class="shop-item-stat">${stats}</div>
      </div>
      <span class="craft-arrow">›</span>
    </div>`;
  });
  html += '</div>';
  return html;
}

function openCraftModal(idx) {
  const recipe = CRAFT_RECIPES[idx];
  if (!recipe) return;
  const result = ITEM_DEF.find(i => i.id === recipe.resultId);
  if (!result) return;
  const p = player;
  const rc = RARITY_COLOR[result.rarity] || '#aaa';
  const canCraft = _canCraft(recipe) && p.gold >= recipe.gold && p.inventory.length < 50;
  const stats = statStr(result);

  const matsHtml = recipe.mats.map(m => {
    const mat = CRAFT_MATS.find(c => c.id === m.id);
    const has = p.inventory.filter(i => i.id === m.id).length;
    const enough = has >= m.n;
    return `<div class="cmod-mat${enough ? '' : ' cmod-mat-lack'}">
      <span class="cmod-mat-icon">${mat ? iconHTML(mat.icon, 18) : '?'}</span>
      <span class="cmod-mat-name">${mat ? mat.name : m.id}</span>
      <span class="cmod-mat-count">${has}/${m.n}</span>
    </div>`;
  }).join('');

  closeCraftModal();
  const div = document.createElement('div');
  div.id = 'craft-modal-ov';
  div.className = 'cmod-overlay';
  div.onclick = closeCraftModal;
  div.innerHTML = `<div class="cmod-box" onclick="event.stopPropagation()">
    <div class="cmod-hdr">
      <span class="cmod-icon">${_itemIcon(result, 40)}</span>
      <div class="cmod-title" style="color:${rc}">${result.name}</div>
      <button class="npc-close" onclick="closeCraftModal()">✕</button>
    </div>
    <div class="cmod-stats">${stats || '—'}</div>
    <div class="cmod-sec">Материалы</div>
    <div class="cmod-mats">${matsHtml}</div>
    <div class="cmod-gold">${iconHTML('coin',14,'#f1c40f')} Стоимость: <b>${recipe.gold}</b></div>
    <button class="shop-btn cmod-craft-btn${canCraft ? '' : ' disabled'}" onclick="craftFromModal(${idx})">Создать</button>
  </div>`;
  document.getElementById('app').appendChild(div);
}

function closeCraftModal() {
  const el = document.getElementById('craft-modal-ov');
  if (el) el.remove();
}

function craftFromModal(idx) {
  closeCraftModal();
  craftItem(idx);
}

function _listMats() {
  const parts = [];
  CRAFT_MATS.forEach(m => {
    const n = player.inventory.filter(i => i.id === m.id).length;
    if (n > 0) parts.push(iconHTML(m.icon, 14) + '×' + n);
  });
  return parts.join(' ') || 'нет';
}

function _canCraft(recipe) {
  return recipe.mats.every(m => player.inventory.filter(i => i.id === m.id).length >= m.n);
}

function craftItem(idx) {
  const recipe = CRAFT_RECIPES[idx];
  if (!recipe || !player) return;
  if (!_canCraft(recipe))              { _shopMsg('Недостаточно материалов!'); return; }
  if (player.gold < recipe.gold)       { _shopMsg('Мало золота!'); return; }
  if (player.inventory.length >= 50)   { _shopMsg('Инвентарь полон!'); return; }
  const result = ITEM_DEF.find(i => i.id === recipe.resultId);
  if (!result) return;

  recipe.mats.forEach(m => {
    let needed = m.n;
    player.inventory = player.inventory.filter(i => {
      if (i.id === m.id && needed > 0) { needed--; return false; }
      return true;
    });
  });
  player.gold -= recipe.gold;
  player.inventory.push({ ...result });
  if (result.slot === 'weapon' && typeof onCraftWeapon === 'function') onCraftWeapon();
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
