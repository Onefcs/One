// ─────────────────────────────────────────────────────────
//  CLAN SYSTEM — client side
// ─────────────────────────────────────────────────────────

// ── Pixel-art icon palette (L2-style) ────────────────────
const _CP = {
  _:null,
  K:'#0a0a1a', k:'#1a1a2e', W:'#ffffff', S:'#b8bcc8', s:'#8890a0',
  G:'#ffd700', g:'#aa8800', R:'#e83030', r:'#901818', B:'#3377ee',
  b:'#1a3388', E:'#22cc44', e:'#115522', P:'#aa33ff', p:'#661199',
  O:'#ff8800', o:'#994400', Y:'#ffee00', N:'#cc8844', n:'#664422',
  C:'#22ccff', H:'#8899aa', D:'#445566', M:'#ff3388', L:'#88aaff',
  A:'#ffaa00', V:'#7722cc',
};

// 30 clan icons — 16×16 pixel grids, L2 crest style
const _ICONS = [
// 1 Dragon Head
['________________',
 '__________RR____',
 '_________RrRR___',
 '________RrRRRR__',
 '_______RRKrKRR__',
 '______RRRrRRRRR_',
 '______RRRRRRRRRR',
 '_____RRRRRRRRRRR',
 '_____RRRRGRRRRR_',
 '______RRRRRRRRRR',
 '_______RRRRRRrr_',
 '________RRRRrr__',
 '_________RRrrr__',
 '__________Rrrr__',
 '___________rr___',
 '________________'],
// 2 Heraldic Shield
['________________',
 '______KKKKKK____',
 '_____KgGGGGgK___',
 '____KgGBBBBGgK__',
 '____KGBRRRRRBGK_',
 '____KGBRSSSSBGk_',
 '____KGBRSWWSBGk_',
 '____KGBRSSSSBGk_',
 '____KGBRRRRRBGK_',
 '____KGGBBBBBGGk_',
 '_____KGGGGGGGk__',
 '______KKKKKKk___',
 '_______KKKKk____',
 '________KKK_____',
 '_________K______',
 '________________'],
// 3 Skull Crown
['________________',
 '____GKGKGKGKg___',
 '___GYGgGgGgGYG__',
 '__GYYYYYYYYYgG__',
 '__GYY__KKK_YgG__',
 '__GKSSSSSSSSKg__',
 '__GKSHHKHHSKKg__',
 '__GKSHHKHHSKKg__',
 '__GKSSKKKSSKKg__',
 '__GKKSHHHSKKg___',
 '__GKK__RR_KKGg__',
 '___GKKKRRKKGg___',
 '___GggggggggG___',
 '____GGGGGGGG____',
 '________________',
 '________________'],
// 4 Phoenix
['___________OO___',
 '__________OOOO__',
 '_________AOAOO__',
 '________AAAOOO__',
 '_______AAAAAOOO_',
 '______AAAAAAOOO_',
 '____RRRRRRRRRRR_',
 '___RYYYYRYRYYYR_',
 '___RRRRRRRRRRRR_',
 '____RRRRRRRRRRR_',
 '_____RRRRRRRRRR_',
 '______RRRRRRRR__',
 '_______RRRRRRR__',
 '________RRRRRR__',
 '_________RRRR___',
 '__________RR____'],
// 5 Castle
['_S__S__S__S__S__',
 '_SSSSSSSSSSSS___',
 '__SSSSSSSSSS____',
 '__SS_SSSS_SS____',
 '__SS_SSSS_SS____',
 '__SSKKKKKKSS____',
 '__SSK____KSS____',
 '__SSK_GG_KSS____',
 '__SSK_GG_KSS____',
 '__SSK____KSS____',
 '__SSKKKKKKSS____',
 '__SSSSSSSSSS____',
 '_SSSSSSSSSSSS___',
 '_SSSSSSSSSSSS___',
 '________________',
 '________________'],
// 6 Paladin Cross
['________________',
 '______GGGGG_____',
 '_____GGGgGGG____',
 '_____GGgggGG____',
 'GGGGGGGGGGGGGGGG',
 'GWWWWWGgGWWWWWGG',
 'GGGGGGGGGGGGGGGG',
 '_____GGgggGG____',
 '_____GGGgGGG____',
 '______GGGGG_____',
 '______GGGGG_____',
 '_____GGGGGGG____',
 '________________',
 '________________',
 '________________',
 '________________'],
// 7 Wolf Head
['________________',
 '___HH_______HH__',
 '__HHH_______HHH_',
 '__HHHHHHHHHHHHH_',
 '__HHHHHHHHHHHHHH',
 '__HHHHDDDDDDHHHH',
 '__HHHHHHHHHHHHH_',
 '__HHHKKHHKKHHH__',
 '__HHHKKHHKKHHH__',
 '__HHHHHrrHHHHH__',
 '___HHHHHHHHHH___',
 '____HHHHHHHH____',
 '____HHHHHHHH____',
 '_____HHHHHH_____',
 '_____HH__HH_____',
 '________________'],
// 8 Flame
['________________',
 '_______AA_______',
 '______AAAA______',
 '____OOAAAAO_____',
 '___OOOAAAAOOO___',
 '__OOOAAYYYAOOO__',
 '__OOAYYYYYROO___',
 '__OAYYYYYYYROO__',
 '_OAYYYYYYYYROOO_',
 '_OAYYYYYYYRROOO_',
 '_OOAYYYYYROOOO__',
 '__OOOAYROOOOOO__',
 '___OOOOOOOOOO___',
 '____OOOOOOOO____',
 '_____OOOOOO_____',
 '______OOOO______'],
// 9 Crown
['________________',
 '__G__________G__',
 '__GG_G_____G_GG_',
 '__GGGGG___GGGGG_',
 '__GGGGGGGGGGGG__',
 '_GGGGGGGGGGGGGGG',
 '_GGYYYYYYYYYYYgG',
 '_GGYRRRRRRRRRYgG',
 '_GGYRRRRRRRRRYgG',
 '_GGYYYYYYYYYYYgG',
 '_GGGGGGGGGGGGGGG',
 '__GGGGGGGGGGGG__',
 '________________',
 '________________',
 '________________',
 '________________'],
// 10 Eagle Wings
['________________',
 '_E____________E_',
 '_EE__________EE_',
 '_EEE________EEE_',
 'EEEE________EEEE',
 'EEEEEE____EEEEEE',
 'EEEEEEEEEEEEEEEE',
 '_EEEEEEEEEEEEEE_',
 '__EEEEEEEEEEEE__',
 '___EEEEEEEEEE___',
 '____EEEGGGEE____',
 '_____EEEGEE_____',
 '______EEEEE_____',
 '_______EEE______',
 '________E_______',
 '________________'],
// 11 Magic Orb
['________________',
 '____PPPPPPPP____',
 '___PPCCCCCCpp___',
 '__PPCCLLLLCCpP__',
 '_PPCCLLWWWLLCCp_',
 '_PCCLLWWWWWLLCp_',
 '_PCCLLWWWWWLLCp_',
 '_PCCLLWWWWWLLCp_',
 '_PPCCLLWWWLLCCp_',
 '__PPCCLLLLCCpP__',
 '___PPCCCCCCpp___',
 '____PPPPPPPP____',
 '________________',
 '________________',
 '________________',
 '________________'],
// 12 Lightning Bolt
['________________',
 '____YYYY________',
 '____YYYYY_______',
 '____YYYYYY______',
 '____YYYYYYY_____',
 '____YYYYYYYY____',
 '____YYYYYYYYY___',
 '_YYYYYYYYYY_____',
 '_YYYYYYYYYY_____',
 '____YYYYYYYY____',
 '___YYYYYYYYY____',
 '___YYYYYYYY_____',
 '___YYYYYYY______',
 '___YYYYYY_______',
 '___YYY__________',
 '________________'],
// 13 Anchor
['________________',
 '_______GGG______',
 '______GGGGG_____',
 '______GG_GG_____',
 '______GG_GG_____',
 'GGGGGGGg_gGGGGGG',
 'GgGGGGGg_gGGGGg_',
 '____GG___GG_____',
 '____GG___GG_____',
 '___GGG___GGG____',
 '__GGGG___GGGG___',
 '__GGG_____GGG___',
 '___GGGGGGGGG____',
 '____GGGGGGG_____',
 '_____GGGGG______',
 '________________'],
// 14 Battle Axe
['_______SS_______',
 '______SSSS______',
 '_____SSSSSS_____',
 '____SSSSSSSS____',
 '___SSSSKSSSSn___',
 '__SSSSSKSSSSSn__',
 '_SSSSSSKSSSSSSn_',
 'SSSSSSKKKSSSSSnn',
 '_SSSSSSKSSSSSSn_',
 '__SSSSSKSSSSSn__',
 '___SSSSKSSSSn___',
 '____SSSKSSSSn___',
 '____SSSKSSSnn___',
 '______SKKS______',
 '______SKKS______',
 '_____SKKKS______'],
// 15 Moon + Star
['________________',
 '____BBBBB_______',
 '___BBBBBBB______',
 '__BBBBBBBBBb____',
 '__BBBBbb________',
 '_BBBBBb____YYYY_',
 '_BBBBBb___YYYYY_',
 '_BBBBBb__YYYYYY_',
 '_BBBBBb___YYYYY_',
 '__BBBBb____YYYY_',
 '__BBBBBBBBBb____',
 '___BBBBBBB______',
 '____BBBBB_______',
 '________________',
 '________________',
 '________________'],
// 16 Crystal
['________________',
 '_______CC_______',
 '______CCCC______',
 '_____CCCCCC_____',
 '____CCLLLLCC____',
 '___CCLLWWLLCC___',
 '__CCLLWWWWLLCC__',
 '_CCLLWWWWWWLLCC_',
 '_CCLLWWWWWWLLCC_',
 '__CCLLWWWWLLCC__',
 '___CCLLWWLLCC___',
 '____CCLLLLCC____',
 '_____CCCCCC_____',
 '______CCCC______',
 '_______CC_______',
 '________________'],
// 17 Snake
['________________',
 '___EEEE_________',
 '__EEeEEEE_______',
 '_EEeEEKEEE______',
 '_EEEEEEEEEe_____',
 '__EEEEEEEEEE____',
 '___EEEEEEEEEe___',
 '____EEEEEEEEEE__',
 '_____EEEEEEEEEe_',
 '______EEEEEEEEEE',
 '_______EEEEEEEe_',
 '________EEEEEE__',
 '_________EEEEe__',
 '__________EEE___',
 '___________EE___',
 '____________E___'],
// 18 Bear Paw
['________________',
 '___NN_NN__NN____',
 '__NNNNNNNNNNn___',
 '__NNNNNNNNNNn___',
 '__NNNNNNNNNN____',
 '__NNNNNNNNNN____',
 '__NNNNNNNNNN____',
 '__NNNNNNNNNN____',
 '__NNNNNNNNNN____',
 '__NNNNNNNNNNn___',
 '_NNNNNNNNNNNn___',
 '_NNNNNNNNNNNn___',
 '__NNNNNNNNNn____',
 '___NNNNNNNn_____',
 '________________',
 '________________'],
// 19 Hammer + Anvil
['________________',
 '____NNNNNNNN____',
 '___NNnnNNNNNN___',
 '___NNnnNNNNNN___',
 '___NNNNNNNNNN___',
 '______NNNN______',
 '______NNNN______',
 '______NNNN______',
 '______NNNN______',
 '____NNNNNNNNn___',
 '___NNNNNNNNNNn__',
 '__NNNNNNNNNNNNn_',
 '__NNNNNNNNNNNNn_',
 '__NNNNNNNNNNNNn_',
 '__nnnnnnnnnnnnn_',
 '________________'],
// 20 Eye of Providence
['________________',
 '________________',
 '________G_______',
 '_______GGG______',
 '_____GGGGGGG____',
 '___GGGGGGGGGGG__',
 '__GGSSSSSSSSGGG_',
 '__GSSSSKKSSSSG__',
 '__GSSSSKKSSSSG__',
 '___GGGGGGGGGGG__',
 '_____GGGGGGG____',
 '_______GGG______',
 '________G_______',
 '________________',
 '________________',
 '________________'],
// 21 Bat Wings
['________________',
 'P______________P',
 'PP_____________P',
 'PPP___________PP',
 'PPPP_________PPP',
 'PPPPP_______PPPP',
 'PPPPP_______PPPP',
 'PPPPPP_____PPPPP',
 'PPPPPPPP_PPPPPPP',
 'PPPPPPPPPPPPPPPP',
 '_PPPPPPPPPPPPPP_',
 '__PPPPPPPPPPPP__',
 '___PPPP___PPPP__',
 '____PP_____PP___',
 '_____P_____P____',
 '________________'],
// 22 Crossed Swords
['_S____________S_',
 '__S__________S__',
 '___S________S___',
 '____S______S____',
 '_____S____S_GG__',
 '______SSSS__GGG_',
 '______SSSS_GGGG_',
 '_____S____S_GGG_',
 '____S______S_GG_',
 '___S________S___',
 '__S__________S__',
 '_S____________S_',
 'S______________S',
 '________________',
 '________________',
 '________________'],
// 23 Griffin Head
['________________',
 '___________GGG__',
 '___BBBBBBBGGGGG_',
 '__BBBBBBBBbGGGGG',
 '__BBBKKBBBbGGGG_',
 '__BBBKKBBBb_GGG_',
 '__BBBBBBBBb_____',
 '__BBBBBBBBBb____',
 '___BBBBBBBBB____',
 '___BBBBbBBBBB___',
 '____BbbbbbBBBB__',
 '______bbbbbb____',
 '______bbbbb_____',
 '_______bbb______',
 '________________',
 '________________'],
// 24 Bow
['________________',
 'B_______________',
 'BB______________',
 'BBB_SSS_________',
 'BBBSSSSS________',
 'BBBB_SSS________',
 'BBBBb___________',
 'BBBBBb__________',
 'BBBBb___________',
 'BBBB_SSS________',
 'BBBSSSSS________',
 'BBB_SSS_________',
 'BB______________',
 'B_______________',
 '________________',
 '________________'],
// 25 Fist
['________________',
 '___NNNN_________',
 '__NNNNNN________',
 '__NNNNNNn_______',
 '_NNNNNNNNn______',
 '_NNNNNNNNNn_____',
 'NNNNNNNNNNNn____',
 'NNNNNNNNNNNNn___',
 'NNNNNNNNNNNNn___',
 'NNNNNNNNNNNn____',
 '_NNNNNNNNNn_____',
 '_NNNNNNNNn______',
 '__NNNNNNn_______',
 '___NNNNn________',
 '________________',
 '________________'],
// 26 Rune / Sigil
['________________',
 '___VVVVVVVV_____',
 '__VVpVVVVVVV____',
 '__VV__VVVV__V___',
 '_VV____VV___VV__',
 '_VV_________VV__',
 '_VV_________VV__',
 '_VV_________VV__',
 '_VV_VVVVV___VV__',
 '__VVVpppVVV_V___',
 '__VVppppppVV____',
 '___VVppppVV_____',
 '____VVppVV______',
 '_____VVVV_______',
 '______VV________',
 '________________'],
// 27 Rose
['________________',
 '______EE________',
 '____EEEEEE______',
 '___EEEMEEEe_____',
 '__EEEMMMEEEe____',
 '__EEEMMMEEEe____',
 '__EEEMMMEEee____',
 '__EEEEE_EEe_____',
 '___EEEEMEEe_____',
 '____MMMMM_______',
 '___MMMMMMMe_____',
 '___MMMMMMMn_____',
 '____MMMMM_______',
 '_____MMM________',
 '______EE________',
 '_______EE_______'],
// 28 Scorpion
['________________',
 '____NNNN________',
 '___NNNNNNn______',
 '__NNNNKNNNn_____',
 '__NNNNKNNNn_____',
 '___NNNNNNNn_____',
 '____NNNNNNNNn___',
 '_____NNNNNNNNn__',
 '_____NNNNNNNn___',
 '____NNNNNNNn____',
 '____NNNNNNn_____',
 '___NNNNNnn______',
 '___N_NN_N_______',
 '__NN__NN_NN_____',
 '________________',
 '________________'],
// 29 Spider
['H______________H',
 '_H____________H_',
 '__H__________H__',
 '___H__HHHH__H___',
 '____HHHHHHHH____',
 '____HHKHHKHH____',
 '____HHHHHHHH____',
 '___H__HHHH__H___',
 '__H__________H__',
 '_H____________H_',
 'H______________H',
 '________________',
 '________________',
 '________________',
 '________________',
 '________________'],
// 30 Mountain
['________________',
 '________WW______',
 '_______WWWW_____',
 '______WWWWWW____',
 '_____WWWWWWWW___',
 '___WWWWSSsWWWW__',
 '__WWWWWSSsWWWWW_',
 '_WWWWWWWWWWWWWW_',
 'SSSSSSSSSSSSSSSS',
 'SSSSSSSSSSSSSSSS',
 'DDDDDDDDDDDDDDDD',
 'DDDDDDDDDDDDDDDD',
 'HHHHHHHHHHHHHHHH',
 'HHHHHHHHHHHHHHHH',
 '________________',
 '________________'],
];

// Draw pixel-art clan icon (16×16) onto a canvas 2D context
function drawClanIconOnCtx(c, iconId, cx, cy, px) {
  const icon = _ICONS[((iconId || 1) - 1) % _ICONS.length];
  const p = px || 1;
  const ox = Math.round(cx - 8 * p);
  const oy = Math.round(cy - 8 * p);
  c.fillStyle = '#0a0a1a';
  c.fillRect(ox, oy, 16 * p, 16 * p);
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
  const rects = [`<rect width="32" height="32" fill="#0a0a1a" rx="2"/>`];
  icon.forEach((row, y) => {
    [...row].forEach((c, x) => {
      const col = _CP[c];
      if (col) rects.push(`<rect x="${x*2}" y="${y*2}" width="2" height="2" fill="${col}"/>`);
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${sz}" height="${sz}" style="image-rendering:pixelated;display:block;border-radius:3px">${rects.join('')}</svg>`;
}

// ── Offscreen clan tag canvas (cached, invalidated on clan change) ────────────
let _clanTagCanvas = null, _clanTagKey = null;
function getClanTagCanvas() {
  if (!clanData || !clanData.name) return null;
  const key = (clanData.icon || 1) + '|' + clanData.name;
  if (_clanTagCanvas && _clanTagKey === key) return _clanTagCanvas;

  const iconPx = 1, iconSz = 16 * iconPx, gap = 3;
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
  const prevClan = clanData;
  const prevLevel = clanData ? clanData.level : null;
  clanData = data;
  _clanTagCanvas = null; _clanTagKey = null;
  if (data && prevLevel !== null && data.level > prevLevel) {
    showClanLevelUp(data.level);
  }
  // Switch to clan home when we just joined/created (had no clan before, now we do)
  if (data && !prevClan) {
    _clanView = 'main';
  }
  // Switch back to no-clan view when kicked/left
  if (!data && prevClan) {
    _clanView = 'main';
  }
  if (activeTab === 4) updateClanUI();
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
