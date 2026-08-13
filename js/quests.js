// ─────────────────────────────────────────────────────────
//  QUEST SYSTEM
// ─────────────────────────────────────────────────────────
let questNotif = null; // { title, timer }
let _activeQuestTab = 'story';
let _specialQuestsCache = null;

function getCurrentQuest() {
  if (!player) return null;
  return QUEST_DEF[player.questIdx] || null;
}

function getQuestProgress(q) {
  if (!player || !q) return {};
  if (q.type === 'kill') {
    const done = q.enemies.reduce((s, name) => s + (player.questKills[name] || 0), 0);
    return { done, total: q.count };
  }
  if (q.type === 'kill_multi') {
    return q.enemies.reduce((o, name) => {
      o[name] = { done: player.questKills[name] || 0, total: q.count };
      return o;
    }, {});
  }
  if (q.type === 'level')         return { done: player.lvl, total: q.level };
  if (q.type === 'buy_potion')    return { done: player.questKills['_potion'] || 0, total: q.count };
  if (q.type === 'craft')         return { done: player.questKills['_craft'] || 0, total: 1 };
  if (q.type === 'dungeon_clear') return { done: player.questKills['_dungeon_' + q.floor] || 0, total: q.count };
  if (q.type === 'join_guild')    return { done: player.questKills['_guild'] || 0, total: 1 };
  if (q.type === 'goto_floor')    return { done: player.questKills['_floor_' + q.targetFloor] || 0, total: 1 };
  return {};
}

function isQuestComplete(q) {
  if (!player || !q) return false;
  if (q.type === 'kill') {
    const done = q.enemies.reduce((s, name) => s + (player.questKills[name] || 0), 0);
    return done >= q.count;
  }
  if (q.type === 'kill_multi')    return q.enemies.every(name => (player.questKills[name] || 0) >= q.count);
  if (q.type === 'level')         return player.lvl >= q.level;
  if (q.type === 'buy_potion')    return (player.questKills['_potion'] || 0) >= q.count;
  if (q.type === 'craft')         return (player.questKills['_craft'] || 0) >= 1;
  if (q.type === 'dungeon_clear') return (player.questKills['_dungeon_' + q.floor] || 0) >= q.count;
  if (q.type === 'join_guild')    return (player.questKills['_guild'] || 0) >= 1;
  if (q.type === 'goto_floor')    return (player.questKills['_floor_' + q.targetFloor] || 0) >= 1;
  return false;
}

function checkQuestComplete() {
  if (!player) return;
  const q = getCurrentQuest();
  if (!q) return;
  if (isQuestComplete(q)) {
    // Quest is done — just refresh UI so the claim button appears
    if (activeTab === 3) updateQuestUI();
  }
}

// The reward itself is granted by the server (see the claimQuest handler,
// server/index.js) — gold and the reward items both. Handing them out here
// and relying on the next saveProgress to carry them stopped working when
// the save path refused to let a client's item list grow: the potions were
// rejected as forged and the player lost them. Nothing is applied locally
// now; onQuestClaimed below applies whatever the server actually granted.
function claimQuest() {
  if (!player) return;
  const q = getCurrentQuest();
  if (!q || !isQuestComplete(q)) return;
  if (_questClaimPending) return;   // one claim in flight at a time
  _questClaimPending = true;
  // Released on the server's answer, but never left latched if that answer
  // is lost (a dropped connection mid-claim): a stuck flag would make the
  // claim button silently do nothing for the rest of the session.
  clearTimeout(_questClaimTimer);
  _questClaimTimer = setTimeout(() => { _questClaimPending = false; updateQuestUI(); }, 8000);
  if (typeof netClaimQuest === 'function') netClaimQuest(player.questIdx);
}

let _questClaimPending = false;
let _questClaimTimer = null;

// The server's authoritative quest counter, sent whenever it notices ours
// has drifted from it — normally because a questClaimed never arrived (a
// disconnect right after the grant) and we have been re-claiming an index
// the server already moved past ever since. Catching up here is what lets
// the next claim actually work instead of failing forever.
function onQuestSync({ questIdx, questKills } = {}) {
  clearTimeout(_questClaimTimer);
  _questClaimPending = false;
  if (!player) return;
  if (Number.isFinite(questIdx)) player.questIdx = questIdx;
  if (questKills && typeof questKills === 'object') player.questKills = questKills;
  updateQuestUI();
}

// Server confirmed the grant: the items are already in player.inventory via
// the inventorySync that preceded this, so only the numbers are left. XP is
// added flat because the server sent the exact figure it recorded.
function onQuestClaimed({ idx, gold, xp, newGold, questIdx } = {}) {
  clearTimeout(_questClaimTimer);
  _questClaimPending = false;
  if (!player) return;
  const q = QUEST_DEF[idx];
  // newGold is the server's total. There is no local fallback any more: gold
  // is not a number this side is allowed to compose.
  if (Number.isFinite(newGold)) player.gold = newGold;
  if (xp > 0 && typeof gainXP === 'function') gainXP(xp, true);
  player.questIdx = Number.isFinite(questIdx) ? questIdx : (player.questIdx + 1);
  player.questKills = {};
  if (q) showQuestComplete(q);
  if (typeof updateHUD === 'function') updateHUD();
  updateQuestUI();
}

function onQuestClaimError(msg) {
  clearTimeout(_questClaimTimer);
  _questClaimPending = false;
  if (typeof _marketToast === 'function') _marketToast(msg || t('genericErrorLbl'), 'err');
  updateQuestUI();
}

function showQuestComplete(q) {
  questNotif = { title: '✓ ' + q.title, timer: 3.5 };
  dmgNum(player.x, player.y - 54, (typeof t === 'function' ? t('questCompleteToast') : 'Квест выполнен!'), '#e69419');
  spawnBurst(player.x, player.y, '#e69419', 12);
}

function tickQuestNotif(dt) {
  if (!questNotif) return;
  questNotif.timer -= dt;
  if (questNotif.timer <= 0) questNotif = null;
}

// ── Event hooks ───────────────────────────────────────────
function onEnemyKill(name) {
  if (!player) return;
  const q = getCurrentQuest();
  if (!q) return;
  if (q.type === 'kill' || q.type === 'kill_multi') {
    if (q.enemies.includes(name)) {
      player.questKills[name] = (player.questKills[name] || 0) + 1;
      checkQuestComplete();
      if (activeTab === 3) updateQuestUI();
    }
  }
}

function onBuyPotion() {
  if (!player) return;
  const q = getCurrentQuest();
  if (!q || q.type !== 'buy_potion') return;
  player.questKills['_potion'] = (player.questKills['_potion'] || 0) + 1;
  checkQuestComplete();
  if (activeTab === 3) updateQuestUI();
}

function onCraftWeapon() {
  if (!player) return;
  const q = getCurrentQuest();
  if (!q || q.type !== 'craft') return;
  player.questKills['_craft'] = (player.questKills['_craft'] || 0) + 1;
  checkQuestComplete();
  if (activeTab === 3) updateQuestUI();
}

function onLevelUp(lvl) {
  if (!player) return;
  const q = getCurrentQuest();
  if (!q || q.type !== 'level') return;
  checkQuestComplete();
  if (activeTab === 3) updateQuestUI();
}

// Open world note: there's no discrete floor to walk into a menu and
// "travel" to anymore — legacy dungeon_clear/goto_floor quests instead
// complete the moment the player's kills reach the corresponding corridor
// (dungeon_clear is awarded in full since repeated "runs" have no real
// equivalent in one seamless world). Called from the enemyKilled handler
// with the killed monster's global room level.
function onEnterArm(rlvl) {
  if (!player || typeof armIndexForLevel !== 'function') return;
  const arm = armIndexForLevel(rlvl);
  if (!player._armCleared) player._armCleared = {};
  for (let f = 1; f < arm; f++) {
    if (player._armCleared[f]) continue;
    player._armCleared[f] = true;
    const dq = QUEST_DEF.find(q => q.type === 'dungeon_clear' && q.floor === f);
    const times = dq ? dq.count : 1;
    for (let i = 0; i < times; i++) onDungeonClear(f);
    onGotoFloor(f + 1);
  }
}

function onDungeonClear(floor) {
  if (!player) return;
  const key = '_dungeon_' + floor;
  player.questKills[key] = (player.questKills[key] || 0) + 1;
  const q = getCurrentQuest();
  if (q && q.type === 'dungeon_clear' && q.floor === floor) {
    checkQuestComplete();
    if (activeTab === 3) updateQuestUI();
  }
}

function onGotoFloor(floor) {
  if (!player) return;
  const key = '_floor_' + floor;
  player.questKills[key] = 1;
  const q = getCurrentQuest();
  if (q && q.type === 'goto_floor' && q.targetFloor === floor) {
    checkQuestComplete();
    if (activeTab === 3) updateQuestUI();
  }
}

function onJoinGuild() {
  if (!player) return;
  player.questKills['_guild'] = 1;
  const q = getCurrentQuest();
  if (q && q.type === 'join_guild') {
    checkQuestComplete();
    if (activeTab === 3) updateQuestUI();
  }
}

function drawQuestNotif() {
  if (!questNotif || !player || !dungeon) return;
  ctx.save();
  const alpha = Math.min(1, questNotif.timer, 3.5 - questNotif.timer + 0.5);
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.fillStyle = 'rgba(46,37,20,0.95)';
  ctx.beginPath();
  ctx.roundRect(W / 2 - 130, HEADER_H + 10, 260, 32, 8);
  ctx.fill();
  ctx.font = 'bold 13px system-ui, Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e69419';
  ctx.fillText(questNotif.title, W / 2, HEADER_H + 31);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── Canvas quest tracker (below minimap, top-right) ───────
function drawQuestTracker() {
  const q = getCurrentQuest();
  if (!player || !dungeon) return;

  // Mirror minimap position from drawHeader
  const mmPad = 6;
  const mmH = HEADER_H - mmPad * 2;
  const mmW = Math.floor(Math.min(mmH * (dungeon.w / dungeon.h), W * 0.27));
  const mmX = W - mmW - mmPad - 4;
  const panelX = mmX - 4;
  const panelW = mmW + 8;

  // Quest notif banner (centered)
  if (questNotif) {
    ctx.save();
    const alpha = Math.min(1, questNotif.timer, 3.5 - questNotif.timer + 0.5);
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = 'rgba(46,37,20,0.95)';
    ctx.beginPath();
    ctx.roundRect(W / 2 - 130, HEADER_H + 10, 260, 32, 8);
    ctx.fill();
    ctx.font = 'bold 13px system-ui, Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#e69419';
    ctx.fillText(questNotif.title, W / 2, HEADER_H + 31);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  if (!q) return;

  let lines = [];
  if (q.type === 'kill') {
    const done = q.enemies.reduce((s, n) => s + (player.questKills[n] || 0), 0);
    lines.push(done + '/' + q.count + ' ' + q.enemies.join(', '));
  } else if (q.type === 'kill_multi') {
    q.enemies.forEach(name => {
      lines.push((player.questKills[name] || 0) + '/' + q.count + ' ' + name);
    });
  } else if (q.type === 'level') {
    lines.push((typeof t === 'function' ? t('questLevelLbl') : 'Уровень') + ' ' + player.lvl + '/' + q.level);
  } else if (q.type === 'buy_potion') {
    lines.push((typeof t === 'function' ? t('questBoughtLbl') : 'Куплено') + ': ' + (player.questKills['_potion'] || 0) + '/' + q.count);
  } else if (q.type === 'craft') {
    lines.push((typeof t === 'function' ? t('questCraftWeapon') : 'Скрафтить оружие'));
  }

  const pad = 7, lineH = 14;
  const panelH = pad * 2 + lineH + lines.length * lineH + 2;
  const py = HEADER_H + 4;

  ctx.save();
  ctx.fillStyle = 'rgba(15,11,5,0.90)';
  ctx.strokeStyle = 'rgba(143,111,57,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(panelX, py, panelW, panelH, 5);
  ctx.fill(); ctx.stroke();

  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 9px system-ui, Arial';
  ctx.fillStyle = '#e69419';
  // Truncate title to fit panel
  const titleMax = Math.floor((panelW - pad * 2) / 5.5);
  const titleStr = q.title.slice(0, titleMax);
  ctx.fillText(titleStr, panelX + pad, py + pad + 9);

  ctx.font = '8px system-ui, Arial';
  ctx.fillStyle = '#bab2a8';
  lines.forEach((ln, i) => {
    ctx.fillText(ln, panelX + pad, py + pad + lineH + (i + 1) * lineH);
  });

  ctx.restore();
}

// ── Quest tab switching ───────────────────────────────────
function switchQuestTab(tab) {
  _activeQuestTab = tab;
  const story   = document.getElementById('quest-list');
  const special = document.getElementById('special-quest-list');
  const btnS    = document.getElementById('qtab-story');
  const btnSp   = document.getElementById('qtab-special');
  if (!story || !special) return;
  if (tab === 'story') {
    story.style.display = '';
    special.style.display = 'none';
    btnS?.classList.add('active');
    btnSp?.classList.remove('active');
    updateQuestUI();
  } else {
    story.style.display = 'none';
    special.style.display = '';
    btnS?.classList.remove('active');
    btnSp?.classList.add('active');
    updateSpecialQuestUI();
  }
}

// Track which quest IDs are currently being submitted to prevent double-clicks
const _specialQuestPending = new Set();

function _specialQuestUnlock(questId) {
  _specialQuestPending.delete(String(questId));
  if (_activeQuestTab === 'special') updateSpecialQuestUI();
}

function _onSpecialQuestClick(questId) {
  if (_specialQuestPending.has(questId)) return;
  _specialQuestPending.add(questId);
  // Re-render so the button shows a pending state immediately
  if (_activeQuestTab === 'special') updateSpecialQuestUI();
  netCompleteSpecialQuest(questId);
  // Safety timeout: if the server never responds, unlock the button after 10s
  setTimeout(() => { _specialQuestUnlock(questId); }, 10000);
}

async function updateSpecialQuestUI() {
  const el = document.getElementById('special-quest-list');
  if (!el || !player) return;
  el.innerHTML = '<div style="color:#968a7a;text-align:center;padding:20px">' + (typeof t === 'function' ? t('questLoading') : 'Загрузка...') + '</div>';
  if (!_specialQuestsCache) _specialQuestsCache = await fetchSpecialQuests();
  const quests = _specialQuestsCache;
  const done = player.specialQuestsDone || [];
  if (!quests.length) {
    el.innerHTML = '<div style="color:#968a7a;text-align:center;padding:20px">' + (typeof t === 'function' ? t('questNoSpecial') : 'Специальных квестов пока нет') + '</div>';
    return;
  }
  let html = '';
  quests.forEach(q => {
    const isDone = done.includes(q._id);
    const isPending = _specialQuestPending.has(String(q._id));
    const icon = q.icon || '⭐';
    const rewardParts = [];
    if (q.reward.gold)  rewardParts.push(iconHTML('coin',12,'#e3941d') + q.reward.gold);
    if (q.reward.xp)    rewardParts.push(iconHTML('star',12,'#e3941d') + q.reward.xp + ' XP');
    if (q.reward.nexum) rewardParts.push('💎' + q.reward.nexum + ' Liberty');
    const rewardStr = rewardParts.join(' · ');
    const typeLabel = q.type === 'subscribe' ? (typeof t === 'function' ? t('questTypeSubscribe') : 'Подписаться') : q.type === 'link' ? (typeof t === 'function' ? t('questTypeLink') : 'Перейти') : (typeof t === 'function' ? t('questTypeDo') : 'Выполнить');
    if (isDone) {
      html += `<div class="quest-item quest-done">
        <div class="quest-header">
          <span class="quest-title">${icon} ${q.title}</span>
          <span class="quest-reward">${rewardStr}</span>
        </div>
        ${q.desc ? `<div class="quest-desc">${q.desc}</div>` : ''}
        <div class="quest-prog" style="color:#79b644">✓ ${typeof t === 'function' ? t('questDoneCheck') : 'Выполнено'}</div>
      </div>`;
    } else if (isPending) {
      html += `<div class="quest-item quest-current">
        <div class="quest-header">
          <span class="quest-title">${icon} ${q.title}</span>
          <span class="quest-reward">${rewardStr}</span>
        </div>
        ${q.desc ? `<div class="quest-desc">${q.desc}</div>` : ''}
        <button class="quest-claim-btn" disabled style="opacity:0.6">${typeof t === 'function' ? t('questSending') : 'Отправка...'}</button>
      </div>`;
    } else {
      const actionBtn = q.url
        ? `<a href="${q.url}" target="_blank" class="quest-claim-btn" style="display:inline-block;text-decoration:none;text-align:center" onclick="_specialQuestPending.add('${q._id}');updateSpecialQuestUI();setTimeout(()=>{ netCompleteSpecialQuest('${q._id}');setTimeout(()=>_specialQuestUnlock('${q._id}'),10000); },1500)">${typeLabel}</a>`
        : `<button class="quest-claim-btn" onclick="_onSpecialQuestClick('${q._id}')">${typeLabel}</button>`;
      html += `<div class="quest-item quest-current">
        <div class="quest-header">
          <span class="quest-title">${icon} ${q.title}</span>
          <span class="quest-reward">${rewardStr}</span>
        </div>
        ${q.desc ? `<div class="quest-desc">${q.desc}</div>` : ''}
        ${actionBtn}
      </div>`;
    }
  });
  el.innerHTML = html;
}

function onSpecialQuestDone(questId, reward, alreadyDone) {
  if (!player) return;
  _specialQuestPending.delete(String(questId));
  reward = reward || {};
  player.specialQuestsDone = player.specialQuestsDone || [];
  if (!player.specialQuestsDone.includes(questId)) player.specialQuestsDone.push(questId);
  // Apply EVERY reward the server granted to the local player. Gold and XP live
  // in the client's save blob, so if we don't mirror them here the next
  // saveProgress overwrites the server's freshly-added reward with our stale
  // value — the reward silently vanishes. XP is added flat (server already
  // applied its own multipliers) via gainXP's flat path, which also handles
  // level-ups. Nexum is server-authoritative and not in the save blob, so we
  // only refresh the displayed balance.
  if (!alreadyDone) {
    // The balance arrives as a total via goldSync; this is display only.
    if (reward.xp && typeof gainXP === 'function') gainXP(reward.xp, true);
    if (reward.nexum) window._nexumBalance = (window._nexumBalance || 0) + reward.nexum;
  }
  if (typeof updateHUD === 'function') updateHUD();
  if (_activeQuestTab === 'special') updateSpecialQuestUI();
  if (!alreadyDone) {
    questNotif = { title: '✓ ' + (typeof t === 'function' ? t('questSpecialCompleteToast') : 'Специальный квест выполнен!'), timer: 3.5 };
    if (typeof spawnBurst === 'function' && player) spawnBurst(player.x, player.y, '#e69419', 12);
  }
  // Sync specialQuestsDone to server immediately so the next autosave can't
  // overwrite it with a stale snapshot that predates this completion.
  if (typeof netSaveProgress === 'function') netSaveProgress();
}

// ── HTML quest panel ──────────────────────────────────────
function _questProgHtml(q, isCur) {
  if (!isCur) return '';
  const complete = isQuestComplete(q);
  if (complete) return `<button class="quest-claim-btn" onclick="claimQuest()">${typeof t === 'function' ? t('questClaimReward') : 'Забрать награду'}</button>`;

  if (q.type === 'kill') {
    const done = q.enemies.reduce((s, n) => s + (player.questKills[n] || 0), 0);
    const pct  = Math.min(100, Math.round(done / q.count * 100));
    return `<div class="quest-prog">${done}/${q.count}
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
  }
  if (q.type === 'kill_multi') {
    return q.enemies.map(name => {
      const done = player.questKills[name] || 0;
      const pct  = Math.min(100, Math.round(done / q.count * 100));
      return `<div class="quest-prog">${name}: ${done}/${q.count}
        <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
    }).join('');
  }
  if (q.type === 'level') {
    const pct = Math.min(100, Math.round(player.lvl / (q.level || 1) * 100));
    return `<div class="quest-prog">${typeof t === 'function' ? t('questLevelLbl') : 'Уровень'} ${player.lvl}/${q.level}
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
  }
  if (q.type === 'buy_potion') {
    const done = player.questKills['_potion'] || 0;
    return `<div class="quest-prog">${done}/${q.count} ${typeof t === 'function' ? t('questBoughtSuffix') : 'куплено'}
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${Math.min(100,Math.round(done/q.count*100))}%"></div></div></div>`;
  }
  if (q.type === 'dungeon_clear') {
    const done = player.questKills['_dungeon_' + q.floor] || 0;
    return `<div class="quest-prog">${done}/${q.count} ${typeof t === 'function' ? t('questTimesSuffix') : 'раз'}
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${Math.min(100,Math.round(done/q.count*100))}%"></div></div></div>`;
  }
  if (q.type === 'join_guild') {
    return `<button class="quest-claim-btn" style="background:linear-gradient(135deg,#614a23,#9c7738)" onclick="onJoinGuild();updateQuestUI()">${typeof t === 'function' ? t('questJoinGuildBtn') : 'Вступить в гильдию'}</button>`;
  }
  if (q.type === 'goto_floor') {
    return `<div class="quest-prog">${typeof tVars === 'function' ? tVars('questReachCorridor', { lvl: ARM_OFFSETS[q.targetFloor - 1] + 1 }) : 'Дойди до монстров уровня ' + (ARM_OFFSETS[q.targetFloor - 1] + 1) + '+ в коридоре'}</div>`;
  }
  if (q.type === 'craft') {
    return `<div class="quest-prog">${typeof t === 'function' ? t('questVisitBlacksmith') : 'Зайди к кузнецу'}</div>`;
  }
  return '';
}

function updateQuestUI() {
  const el = document.getElementById('quest-list');
  if (!el || !player) return;
  if (_activeQuestTab !== 'story') return;

  // Group quests by floor
  const floors = [...new Set(QUEST_DEF.map(q => q.floor || 1))].sort((a, b) => a - b);
  let html = '';

  floors.forEach(floorNum => {
    const floorQuests = QUEST_DEF.map((q, i) => ({ q, i })).filter(({ q }) => (q.floor || 1) === floorNum);
    const firstIdx    = floorQuests[0].i;
    const lastIdx     = floorQuests[floorQuests.length - 1].i;
    // Floor section is locked if player hasn't reached its first quest yet —
    // just don't show anything for it yet (no "will unlock on floor N" teaser;
    // completing everything above is what reveals it, see player.questIdx).
    const floorLocked = player.questIdx < firstIdx;
    if (floorLocked) return;

    const doneCnt = Math.min(player.questIdx - firstIdx, floorQuests.length);
    html += `<div class="quest-floor-hdr">${typeof t === 'function' ? t('questFloorLbl') : 'Этаж'} ${floorNum} · <span style="color:#968a7a;font-weight:normal">${doneCnt}/${floorQuests.length} ${typeof t === 'function' ? t('questCompletedSuffix') : 'выполнено'}</span></div>`;

    floorQuests.forEach(({ q, i }) => {
      const isDone = i < player.questIdx;
      const isCur  = i === player.questIdx;
      const cls    = isDone ? 'quest-item quest-done' : isCur ? 'quest-item quest-current' : 'quest-item quest-locked';
      const rewardStr = [
        q.reward.xp > 0 ? iconHTML('star',12,'#e3941d') + q.reward.xp + ' XP' : '',
        iconHTML('coin',12,'#e3941d') + q.reward.gold,
        q.reward.items ? iconHTML('potion',12,'#90d653') + '×' + q.reward.items.length : '',
      ].filter(Boolean).join(' · ');
      const statusIcon = isDone
        ? iconHTML('hpPlus', 14, '#79b644')
        : isCur ? iconHTML('star', 14, '#e69419') : iconHTML('skull', 14, '#5f574b');

      html += `<div class="${cls}">
        <div class="quest-header">
          <span class="quest-title">${statusIcon} ${q.title}</span>
          <span class="quest-reward">${rewardStr}</span>
        </div>
        <div class="quest-desc">${q.desc}</div>
        ${_questProgHtml(q, isCur)}
      </div>`;
    });
  });

  el.innerHTML = html;
}
