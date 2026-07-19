// ─────────────────────────────────────────────────────────
//  CLAN SYSTEM — client side
// ─────────────────────────────────────────────────────────

// ── Pixel-art icon palette ────────────────────────────────
const _CP = {
  _:null,  S:'#c8c8d0', G:'#ffd700', R:'#e74c3c', B:'#4488ee',
  P:'#9b59b6', O:'#f39c12', E:'#27ae60', N:'#8B4513', Y:'#f1c40f',
  C:'#16a085', D:'#556677', W:'#ffffff', K:'#222233', M:'#e91e63',
  L:'#87ceeb', T:'#2c3e50', A:'#e67e22', H:'#95a5a6',
};

// 30 clan icons as 8×8 pixel grids (each char = one 3×3 SVG rect)
const _ICONS = [
// 1 Sword
['__SS____','___SS___','____SS__','_GGSSG__','__SSS___','___SS___','___SN___','____N___'],
// 2 Shield
['_SSSSSS_','SSGGSSS_','SSGGSSS_','SSGGSSS_','_SSSSSS_','__SSSS__','___SS___','________'],
// 3 Skull
['__RRRR__','_RRRRRR_','RRKKRKRR','RRRRRRRR','_RRRRRR_','_RKKKRR_','__RRRR__','________'],
// 4 Crown
['G_GGG_G_','G_GGG_G_','GGGGGGG_','GYRRRGY_','GGGGGGG_','GGGGGGG_','________','________'],
// 5 Flame
['___OO___','__OOOO__','_YYYYOO_','YYYYOOO_','YYYOOOO_','_YYOOOO_','__YYYY__','___YY___'],
// 6 Axe
['___SS___','__SSS___','_SSSSS__','SSSSSSN_','_SSSNN__','__SSNN__','___NN___','___NN___'],
// 7 Bow
['B_______','BB______','BB_SSS__','BBSSSSS_','BB_SSS__','BB______','B_______','________'],
// 8 Magic Staff
['___PP___','__PPP___','___PP___','___DD___','__DDD___','___DD___','___DD___','__DDD___'],
// 9 Castle
['SSSSSSS_','S_S_S_S_','SSSSSSS_','SS___SS_','SS_K_SS_','SS___SS_','SSSSSSS_','________'],
// 10 Mountain
['___WW___','__WWWW__','_WWWWWW_','WWWWWWWW','HHHHHHHH','________','________','________'],
// 11 Lightning
['__YYY___','__YYYY__','___YYY__','__YYYYY_','_YYYY___','__YYY___','___YY___','___Y____'],
// 12 Moon
['__BBBB__','_BBBBBB_','_BB_____','BB______','BB______','_BB_____','_BBBBBB_','__BBBB__'],
// 13 Sun
['Y__Y__Y_','_YYYYYY_','__YYYY__','YYYYYYYY','__YYYY__','_YYYYYY_','Y__Y__Y_','________'],
// 14 Star
['___YY___','_YYYYYY_','YYYYYYYY','_YYYYYY_','__YYYY__','_YY__YY_','YY____YY','________'],
// 15 Potion
['___SS___','__SSSS__','_SBBBBS_','SBBBBBS_','SBBBBBS_','SBBBBBS_','_SSSSSS_','___SS___'],
// 16 Spider
['S______S','_S____S_','__KKKK__','_KKKKKK_','__KKKK__','_S____S_','S______S','________'],
// 17 Cat Face
['S__SS__S','__SSSS__','SSSSSSSS','_SBBSBS_','SSSSSSSS','__SRSS__','_S____S_','________'],
// 18 Bat
['P______P','PP____PP','PPPPPPPP','_PPPPPP_','__PPPP__','__PPPP__','___PP___','___PP___'],
// 19 Eye
['___SSSS_','_SSSSSS_','SSBBBSSS','SSBKBSSS','SSBBBSSS','_SSSSSS_','___SSSS_','________'],
// 20 Hammer
['_NNNNNN_','NNNNNNNK','NNNNNNNK','___SS___','___SS___','___SS___','___SS___','__SSSS__'],
// 21 Crystal
['___CC___','__CCCC__','_CCCCCC_','CCCCCCCC','CCCCCCCC','_CCCCCC_','__CCCC__','___CC___'],
// 22 Fist
['_NNNN___','NNNNNNNN','NNNNNNNN','NNNNNNNN','_NNNNNN_','_NNNNNN_','__NNNN__','________'],
// 23 Snake
['__EEE___','_EEEEE__','EE__EEE_','EE_EEE__','EEEEE___','_EEE____','__EE____','________'],
// 24 Dragon
['__RR____','_RRRR___','RRRRRR__','RRYRRRR_','RRRRRRRR','__RRRR__','_RRRRRR_','________'],
// 25 Phoenix
['__AA____','_AAAA___','AAYAAA__','_RRRRR__','RRRRRRR_','_AAAAAA_','A______A','________'],
// 26 Wolf
['WW____WW','WWW__WWW','WWWWWWWW','WWBBWBWW','WWWWWWWW','_WWWWWW_','__WWWW__','__WSSW__'],
// 27 Bear Paw
['_NNN__NN','_NNN__N_','__NNNNN_','_NNNNNNN','NNNNNNNN','_NNNNNNN','__NNNNN_','________'],
// 28 Eagle
['S______S','SS_SS_SS','SSSSSSSS','_SSSSSS_','__SSSSS_','__YYSS__','_SS__SS_','________'],
// 29 Anchor
['__GGG___','_GGGGG__','___GG___','_GGGGG__','GG_GG_GG','_G_GG_G_','__GGG___','________'],
// 30 Rose
['__EE____','_EEEE___','EEMEEEE_','_MMMMM__','__MMMM__','___MM___','___EE___','___EE___'],
];

// Draw pixel-art clan icon directly onto a canvas 2D context
// cx/cy = center of the 8×8 icon, px = pixel size in CSS px
function drawClanIconOnCtx(c, iconId, cx, cy, px) {
  const icon = _ICONS[((iconId || 1) - 1) % _ICONS.length];
  const p = px || 1;
  const ox = Math.round(cx - 4 * p);
  const oy = Math.round(cy - 4 * p);
  icon.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const col = _CP[ch];
      if (!col) return;
      c.fillStyle = col;
      c.fillRect(ox + x * p, oy + y * p, p, p);
    });
  });
}

function clanIconSVG(id, size) {
  const icon = _ICONS[(id - 1) % _ICONS.length];
  const sz = size || 40;
  const rects = [];
  icon.forEach((row, y) => {
    [...row].forEach((c, x) => {
      const col = _CP[c];
      if (col) rects.push(`<rect x="${x*3}" y="${y*3}" width="3" height="3" fill="${col}"/>`);
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${sz}" height="${sz}" style="image-rendering:pixelated;display:block">${rects.join('')}</svg>`;
}

// ── Offscreen clan tag canvas (cached, invalidated on clan change) ────────────
let _clanTagCanvas = null, _clanTagKey = null;
function getClanTagCanvas() {
  if (!clanData || !clanData.name) return null;
  const key = (clanData.icon || 1) + '|' + clanData.name;
  if (_clanTagCanvas && _clanTagKey === key) return _clanTagCanvas;

  const iconPx = 1, iconSz = 8 * iconPx, gap = 3;
  // Measure text width using a throwaway canvas
  const tmp = document.createElement('canvas');
  const tc = tmp.getContext('2d');
  tc.font = 'bold 9px system-ui, Arial';
  const ctw = tc.measureText(clanData.name).width;
  const w = Math.ceil(iconSz + gap + ctw) + 4;
  const h = 10;

  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  const c = oc.getContext('2d');
  c.textBaseline = 'middle';
  drawClanIconOnCtx(c, clanData.icon, iconSz / 2, h / 2, iconPx);
  c.font = 'bold 9px system-ui, Arial';
  c.strokeStyle = '#000'; c.lineWidth = 2; c.textAlign = 'left';
  c.strokeText(clanData.name, iconSz + gap, h / 2);
  c.fillStyle = '#f93';
  c.fillText(clanData.name, iconSz + gap, h / 2);

  _clanTagCanvas = oc;
  _clanTagKey = key;
  return _clanTagCanvas;
}

// ── Active clan bonuses (cumulative at current level) ─────
function getClanBonus() {
  if (!clanData) return { gold: 0, xp: 0, atk: 0 };
  const lvl = CLAN_LEVELS[(clanData.level || 1) - 1];
  return lvl ? { ...lvl.bonus } : { gold: 0, xp: 0, atk: 0 };
}

// ── UI state ──────────────────────────────────────────────
let _clanView = 'main';      // 'main' | 'create' | 'search' | 'icon-pick'
let _clanNewName = '';
let _clanNewIcon = 1;
let _clanSearchResults = null;   // null = loading, [] = empty result
let _clanHomeTab = 0;            // 0=клан, 1=участники, 2=навыки

function updateClanUI() {
  const el = document.getElementById('clan-body');
  if (!el || !player) return;

  if (_clanView === 'create')      { _renderCreate(el); return; }
  if (_clanView === 'icon-pick')   { _renderIconPick(el); return; }
  if (_clanView === 'search')      { _renderSearch(el); return; }

  if (clanData) {
    _renderClanHome(el);
  } else {
    _renderNoClan(el);
  }
}

// ── No clan screen ────────────────────────────────────────
function _renderNoClan(el) {
  el.innerHTML = `
    <div class="clan-empty">
      <div class="clan-empty-icon">${clanIconSVG(1, 64)}</div>
      <div class="clan-empty-title">У вас нет клана</div>
      <div class="clan-empty-sub">Создайте свой клан или найдите существующий</div>
      <button class="clan-btn clan-btn-create" onclick="_clanGoCreate()">+ Создать клан</button>
      <button class="clan-btn clan-btn-search" onclick="_clanGoSearch()">Найти клан</button>
    </div>`;
}

// ── Create clan screen ────────────────────────────────────
function _clanGoCreate() { _clanView = 'create'; _clanNewName = ''; _clanNewIcon = 1; updateClanUI(); }
function _clanGoSearch()  { _clanView = 'search'; _clanSearchResults = null; updateClanUI(); netClanSearch(''); }
function _clanGoMain()    { _clanView = 'main'; updateClanUI(); }

function _renderCreate(el) {
  el.innerHTML = `
    <div class="clan-form">
      <button class="clan-back" onclick="_clanGoMain()">← Назад</button>
      <div class="clan-form-title">Создать клан</div>
      <div class="clan-form-label">Название (до 10 символов)</div>
      <input class="clan-input" id="clan-name-inp" maxlength="10" placeholder="Название..." value="${_clanNewName}"
             oninput="_clanNewName=this.value;_clanUpdatePreview()">
      <div class="clan-form-label" style="margin-top:14px">Иконка клана</div>
      <div class="clan-icon-preview" onclick="_clanPickIcon()">
        ${clanIconSVG(_clanNewIcon, 48)}
        <span class="clan-icon-change">Изменить</span>
      </div>
      <div id="clan-create-err" class="clan-err"></div>
      <button class="clan-btn clan-btn-create" style="margin-top:16px" onclick="_clanSubmitCreate()">Создать</button>
    </div>`;
}

function _clanUpdatePreview() {}

function _clanPickIcon() { _clanView = 'icon-pick'; updateClanUI(); }

function _renderIconPick(el) {
  const grid = _ICONS.map((_, i) => {
    const id = i + 1;
    const sel = id === _clanNewIcon ? ' clan-icon-sel' : '';
    return `<div class="clan-icon-cell${sel}" onclick="_clanSelectIcon(${id})">${clanIconSVG(id, 36)}</div>`;
  }).join('');
  el.innerHTML = `
    <div class="clan-form">
      <button class="clan-back" onclick="_clanView='create';updateClanUI()">← Назад</button>
      <div class="clan-form-title">Выбери иконку</div>
      <div class="clan-icon-grid">${grid}</div>
    </div>`;
}

function _clanSelectIcon(id) { _clanNewIcon = id; _clanView = 'create'; updateClanUI(); }

function _clanSubmitCreate() {
  const name = (_clanNewName || '').trim();
  if (!name) { const e = document.getElementById('clan-create-err'); if (e) e.textContent = 'Введите название'; return; }
  netClanCreate(name, _clanNewIcon);
}

// ── Search screen ─────────────────────────────────────────
function _renderSearch(el) {
  let results;
  if (_clanSearchResults === null) {
    results = '<div class="clan-nores">Загрузка...</div>';
  } else if (_clanSearchResults.length === 0) {
    results = '<div class="clan-nores">Кланы не найдены</div>';
  } else {
    results = _clanSearchResults.map(c => `
    <div class="clan-result">
      <div class="clan-result-icon">${clanIconSVG(c.icon, 36)}</div>
      <div class="clan-result-info">
        <div class="clan-result-name">${_esc(c.name)}</div>
        <div class="clan-result-meta">Ур. ${c.level} · ${c.members} участников</div>
      </div>
      <button class="clan-btn-sm" onclick="netClanApply('${c._id}')">Вступить</button>
    </div>`).join('');
  }

  el.innerHTML = `
    <div class="clan-form">
      <button class="clan-back" onclick="_clanGoMain()">← Назад</button>
      <div class="clan-form-title">Найти клан</div>
      <div class="clan-search-row">
        <input class="clan-input" id="clan-search-inp" placeholder="Название клана..." maxlength="10">
        <button class="clan-btn-sm" onclick="_clanDoSearch()">Найти</button>
      </div>
      <div id="clan-search-results">${results}</div>
    </div>`;
}

function _clanDoSearch() {
  const inp = document.getElementById('clan-search-inp');
  if (inp) netClanSearch(inp.value.trim());
}

// ── Clan home screen ──────────────────────────────────────
function _setClanHomeTab(n) { _clanHomeTab = n; updateClanUI(); }

function _renderClanHome(el) {
  const c = clanData;
  const lvlDef = CLAN_LEVELS[(c.level || 1) - 1];
  const nextDef = CLAN_LEVELS[c.level] || null;
  const xpPct = nextDef ? Math.min(100, Math.round((c.xp - lvlDef.xpReq) / (nextDef.xpReq - lvlDef.xpReq) * 100)) : 100;
  const bonus = getClanBonus();
  const isLeader = c.myRole === 'leader';
  const myBM = typeof calcBM === 'function' && player ? calcBM(player) : 0;

  const bonusLines = [];
  if (bonus.gold > 0) bonusLines.push(`+${bonus.gold}% золото`);
  if (bonus.xp   > 0) bonusLines.push(`+${bonus.xp}% опыт`);
  if (bonus.atk  > 0) bonusLines.push(`+${bonus.atk}% атака`);
  const bonusHtml = bonusLines.length
    ? bonusLines.map(l => `<span class="clan-bonus-tag">${l}</span>`).join('')
    : '<span class="clan-bonus-tag clan-bonus-none">бонусов пока нет</span>';

  const tabs = ['Клан', 'Участники', 'Навыки'];
  const tabHtml = tabs.map((t, i) =>
    `<div class="clan-tab${_clanHomeTab === i ? ' active' : ''}" onclick="_setClanHomeTab(${i})">${t}</div>`
  ).join('');

  let bodyHtml = '';
  if (_clanHomeTab === 0) {
    // ── Клан tab: info + XP bar + leave/disband ────────────
    bodyHtml = `
      <div class="clan-xp-block">
        <div class="clan-xp-label">
          Очки клана: ${c.xp.toLocaleString()}
          ${nextDef ? `· до ур.${c.level+1}: ${(nextDef.xpReq - c.xp).toLocaleString()}` : '· Макс. уровень'}
        </div>
        <div class="clan-xp-bar-bg"><div class="clan-xp-bar-fill" style="width:${xpPct}%"></div></div>
      </div>
      <div class="clan-bonus-row" style="margin-bottom:14px">${bonusHtml}</div>
      ${myBM ? `<div class="clan-my-bm">Ваша БМ: <span>${myBM.toLocaleString()}</span></div>` : ''}
      <div style="margin-top:16px">
        ${isLeader
          ? `<button class="clan-btn clan-btn-danger" onclick="_clanConfirmDisband()">Расформировать</button>`
          : `<button class="clan-btn clan-btn-leave" onclick="_clanConfirmLeave()">Покинуть клан</button>`}
      </div>`;
  } else if (_clanHomeTab === 1) {
    // ── Участники tab ──────────────────────────────────────
    const membersHtml = (c.members || [])
      .slice().sort((a, b) => (b.bm || 0) - (a.bm || 0))
      .map(m => {
        const roleIcon = m.role === 'leader' ? '👑' : '⚔️';
        const kickBtn = isLeader && m.role !== 'leader'
          ? `<button class="clan-btn-sm clan-btn-danger" onclick="netClanKick('${m.telegramId}')">Исключить</button>`
          : '';
        return `<div class="clan-member">
          <span class="clan-member-role">${roleIcon}</span>
          <span class="clan-member-name">${_esc(m.username)}</span>
          ${m.bm ? `<span class="clan-member-bm">БМ ${m.bm.toLocaleString()}</span>` : ''}
          ${kickBtn}
        </div>`;
      }).join('');

    let appsHtml = '';
    if (isLeader && c.applications && c.applications.length > 0) {
      appsHtml = `<div class="clan-section-hdr" style="margin-top:14px">Заявки (${c.applications.length})</div>` +
        c.applications.map(a => `
          <div class="clan-member">
            <span class="clan-member-name">⌛ ${_esc(a.username)}</span>
            <button class="clan-btn-sm" onclick="netClanApprove('${a.telegramId}')">Принять</button>
            <button class="clan-btn-sm clan-btn-danger" onclick="netClanDecline('${a.telegramId}')">Отказать</button>
          </div>`).join('');
    }
    bodyHtml = `
      <div class="clan-section-hdr">Участники (${(c.members||[]).length}) · по БМ</div>
      ${membersHtml}
      ${appsHtml}`;
  } else {
    // ── Навыки tab: perk tree by level ────────────────────
    const PERKS_RU = [
      { lvl:2,  icon:'💰', label:'Золото', desc:'+5% к золоту с врагов'   },
      { lvl:3,  icon:'⚡', label:'Опыт',   desc:'+5% к опыту с врагов'    },
      { lvl:4,  icon:'💰', label:'Золото', desc:'+10% к золоту суммарно'  },
      { lvl:5,  icon:'⚔️', label:'Атака',  desc:'+5% к атаке участников'  },
      { lvl:6,  icon:'⚡', label:'Опыт',   desc:'+10% к опыту суммарно'   },
      { lvl:7,  icon:'💰', label:'Золото', desc:'+15% к золоту суммарно'  },
      { lvl:8,  icon:'⚔️', label:'Атака',  desc:'+10% к атаке суммарно'   },
      { lvl:9,  icon:'⚡', label:'Опыт',   desc:'+15% к опыту суммарно'   },
      { lvl:10, icon:'💰', label:'Золото', desc:'+20% к золоту'            },
      { lvl:10, icon:'⚡', label:'Опыт',   desc:'+20% к опыту'             },
      { lvl:10, icon:'⚔️', label:'Атака',  desc:'+15% к атаке'             },
    ];
    const perksHtml = PERKS_RU.map(pk => {
      const unlocked = c.level >= pk.lvl;
      const cls = unlocked ? 'clan-perk unlocked' : 'clan-perk locked';
      return `<div class="${cls}">
        <div class="clan-perk-icon">${pk.icon}</div>
        <div class="clan-perk-body">
          <div class="clan-perk-name">${pk.label} <span class="clan-perk-lvl">Ур.${pk.lvl}</span></div>
          <div class="clan-perk-desc">${pk.desc}</div>
        </div>
      </div>`;
    }).join('');
    bodyHtml = `
      <div class="clan-section-hdr">Бонусы клана по уровням</div>
      <div class="clan-perks">${perksHtml}</div>`;
  }

  el.innerHTML = `
    <div class="clan-home">
      <div class="clan-hdr">
        <div class="clan-hdr-icon">${clanIconSVG(c.icon, 48)}</div>
        <div class="clan-hdr-info">
          <div class="clan-hdr-name">${_esc(c.name)}</div>
          <div class="clan-hdr-level">${lvlDef.label} · Ур. ${c.level}/10</div>
        </div>
      </div>
      <div class="clan-tabs">${tabHtml}</div>
      ${bodyHtml}
    </div>`;
}

function _clanConfirmLeave() {
  if (confirm('Покинуть клан?')) netClanLeave();
}
function _clanConfirmDisband() {
  if (confirm('Расформировать клан? Это нельзя отменить.')) netClanDisband();
}

// ── Notification when clan levels up ─────────────────────
function showClanLevelUp(level) {
  const lvDef = CLAN_LEVELS[level - 1];
  dmgNum(player.x, player.y - 54, `Клан уровень ${level}!`, '#ffd700');
  spawnBurst(player.x, player.y, '#ffd700', 10);
  if (lvDef) {
    const b = lvDef.bonus;
    const parts = [b.gold?`+${b.gold}% золото`:'', b.xp?`+${b.xp}%опыт`:'', b.atk?`+${b.atk}%атака`:''].filter(Boolean);
    if (parts.length) dmgNum(player.x, player.y - 72, parts.join(' '), '#ffd700');
  }
}

// ── Helpers ───────────────────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Called from network.js when server pushes clan state
function onClanData(data) {
  const prevLevel = clanData ? clanData.level : null;
  clanData = data;
  _clanTagCanvas = null; _clanTagKey = null;
  if (data && prevLevel !== null && data.level > prevLevel) {
    showClanLevelUp(data.level);
  }
  if (activeTab === 5) updateClanUI();
}

function onClanError(msg) {
  const errEl = document.getElementById('clan-create-err');
  if (errEl) { errEl.textContent = msg; return; }
  const body = document.getElementById('clan-body');
  if (body) {
    const d = document.createElement('div');
    d.className = 'clan-err';
    d.textContent = msg;
    body.prepend(d);
    setTimeout(() => d.remove(), 3000);
  }
}

function onClanSearchResults(results) {
  _clanSearchResults = results;
  const el = document.getElementById('clan-search-results');
  if (!el) return;
  el.innerHTML = results.length
    ? results.map(c => `
      <div class="clan-result">
        <div class="clan-result-icon">${clanIconSVG(c.icon, 36)}</div>
        <div class="clan-result-info">
          <div class="clan-result-name">${_esc(c.name)}</div>
          <div class="clan-result-meta">Ур. ${c.level} · ${c.members} участников</div>
        </div>
        <button class="clan-btn-sm" onclick="netClanApply('${c._id}')">Вступить</button>
      </div>`).join('')
    : '<div class="clan-nores">Кланы не найдены</div>';
}
