// ─────────────────────────────────────────────────────────
//  NPC DIALOG SYSTEM
// ─────────────────────────────────────────────────────────
function openNpc(npcId) {
  if (!npcId || !player) return;
  const def = NPC_DEF.find(n => n.id === npcId);
  if (!def) return;

  document.getElementById('npc-emoji-lbl').textContent = def.emoji;
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
  let html = `<div class="shop-gold">💰 Золото: <b>${p.gold}</b> · 🧪 Зелий: <b>${p.potions}/5</b></div>`;
  html += '<div class="shop-sec">Зелья</div><div class="shop-list">';
  MERCHANT_SHOP.forEach((entry, idx) => {
    const canBuy = p.gold >= entry.price && (p.potions || 0) < 5;
    html += `<div class="shop-row">
      <span class="shop-item-icon">${entry.emoji}</span>
      <span class="shop-item-name">${entry.name}</span>
      <span class="shop-item-stat">${entry.desc}</span>
      <button class="shop-btn${canBuy ? '' : ' disabled'}" onclick="buyPotion(${idx})">
        ${entry.price}💰
      </button>
    </div>`;
  });
  html += '</div>';
  return html;
}

function buyPotion(idx) {
  const entry = MERCHANT_SHOP[idx];
  if (!entry || !player) return;
  if ((player.potions || 0) >= 5) { _shopMsg('Максимум 5 зелий!'); return; }
  if (player.gold < entry.price)  { _shopMsg('Мало золота!'); return; }
  player.gold -= entry.price;
  player.potions = (player.potions || 0) + 1;
  if (typeof onBuyPotion === 'function') onBuyPotion();
  netSaveProgress();
  openNpc('merchant');
}

// ── Craftsman ───────────────────────────────────────────
function _craftsmanBody() {
  const p = player;
  let html = `<div class="shop-gold">💰 Золото: <b>${p.gold}</b></div>`;
  html += '<div class="shop-sec">Рецепты крафта</div>';
  html += '<div class="craft-mats-info">Материалы в инвентаре: ' + _listMats() + '</div>';
  html += '<div class="shop-list">';
  CRAFT_RECIPES.forEach((recipe, idx) => {
    const result = ITEM_DEF.find(i => i.id === recipe.resultId);
    if (!result) return;
    const rc = RARITY_COLOR[result.rarity] || '#aaa';
    const canCraft = _canCraft(recipe) && p.gold >= recipe.gold && p.inventory.length < 10;
    const matsStr = recipe.mats.map(m => {
      const mat = CRAFT_MATS.find(c => c.id === m.id);
      const has = p.inventory.filter(i => i.id === m.id).length;
      return `${mat ? mat.emoji : '?'}×${m.n}(${has})`;
    }).join(' ');
    html += `<div class="shop-row">
      <span class="shop-item-icon">${result.emoji}</span>
      <div class="shop-item-info">
        <div class="shop-item-name" style="color:${rc}">${result.name}</div>
        <div class="shop-item-stat">${matsStr} · ${recipe.gold}💰</div>
      </div>
      <button class="shop-btn${canCraft ? '' : ' disabled'}" onclick="craftItem(${idx})">Создать</button>
    </div>`;
  });
  html += '</div>';
  return html;
}

function _listMats() {
  const counts = {};
  CRAFT_MATS.forEach(m => {
    const n = player.inventory.filter(i => i.id === m.id).length;
    if (n > 0) counts[m.emoji] = n;
  });
  const str = Object.entries(counts).map(([e, n]) => `${e}×${n}`).join(' ');
  return str || 'нет';
}

function _canCraft(recipe) {
  return recipe.mats.every(m => player.inventory.filter(i => i.id === m.id).length >= m.n);
}

function craftItem(idx) {
  const recipe = CRAFT_RECIPES[idx];
  if (!recipe || !player) return;
  if (!_canCraft(recipe))              { _shopMsg('Недостаточно материалов!'); return; }
  if (player.gold < recipe.gold)       { _shopMsg('Мало золота!'); return; }
  if (player.inventory.length >= 10)   { _shopMsg('Инвентарь полон!'); return; }
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
  let html = `<div class="shop-gold">💰 Золото: <b>${p.gold}</b> · Инвентарь: <b>${p.inventory.length}/10</b></div>`;
  html += '<div class="shop-sec">Товары</div><div class="shop-list">';
  SHOP_CATALOG.forEach(entry => {
    const item = ITEM_DEF.find(i => i.id === entry.itemId);
    if (!item) return;
    const rc = RARITY_COLOR[item.rarity] || '#aaa';
    const canBuy = p.gold >= entry.price && p.inventory.length < 10;
    const stats = statStr(item);
    html += `<div class="shop-row">
      <span class="shop-item-icon">${item.emoji}</span>
      <div class="shop-item-info">
        <div class="shop-item-name" style="color:${rc}">${item.name}</div>
        <div class="shop-item-stat">${stats}</div>
      </div>
      <button class="shop-btn${canBuy ? '' : ' disabled'}" onclick="buyShopItem('${entry.itemId}',${entry.price})">
        ${entry.price}💰
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
  if (player.inventory.length >= 10) { _shopMsg('Инвентарь полон!'); return; }
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
