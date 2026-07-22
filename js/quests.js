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

function claimQuest() {
  if (!player) return;
  const q = getCurrentQuest();
  if (!q || !isQuestComplete(q)) return;
  if (q.reward.xp > 0) gainXP(q.reward.xp);
  player.gold += q.reward.gold;
  showQuestComplete(q);
  player.questIdx++;
  player.questKills = {};
  netSaveProgress();
  updateQuestUI();
}

function showQuestComplete(q) {
  questNotif = { title: '✓ ' + q.title, timer: 3.5 };
  dmgNum(player.x, player.y - 54, 'Квест выполнен!', '#fd0');
  spawnBurst(player.x, player.y, '#fd0', 12);
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
  ctx.fillStyle = 'rgba(20,16,50,0.95)';
  ctx.beginPath();
  ctx.roundRect(W / 2 - 130, HEADER_H + 10, 260, 32, 8);
  ctx.fill();
  ctx.font = 'bold 13px system-ui, Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fd0';
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
    ctx.fillStyle = 'rgba(20,16,50,0.95)';
    ctx.beginPath();
    ctx.roundRect(W / 2 - 130, HEADER_H + 10, 260, 32, 8);
    ctx.fill();
    ctx.font = 'bold 13px system-ui, Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fd0';
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
    lines.push('Уровень ' + player.lvl + '/' + q.level);
  } else if (q.type === 'buy_potion') {
    lines.push('Куплено: ' + (player.questKills['_potion'] || 0) + '/' + q.count);
  } else if (q.type === 'craft') {
    lines.push('Скрафтить оружие');
  }

  const pad = 7, lineH = 14;
  const panelH = pad * 2 + lineH + lines.length * lineH + 2;
  const py = HEADER_H + 4;

  ctx.save();
  ctx.fillStyle = 'rgba(6,4,16,0.90)';
  ctx.strokeStyle = 'rgba(70,45,155,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(panelX, py, panelW, panelH, 5);
  ctx.fill(); ctx.stroke();

  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 9px system-ui, Arial';
  ctx.fillStyle = '#fd0';
  // Truncate title to fit panel
  const titleMax = Math.floor((panelW - pad * 2) / 5.5);
  const titleStr = q.title.slice(0, titleMax);
  ctx.fillText(titleStr, panelX + pad, py + pad + 9);

  ctx.font = '8px system-ui, Arial';
  ctx.fillStyle = '#bbb';
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
  el.innerHTML = '<div style="color:#888;text-align:center;padding:20px">Загрузка...</div>';
  if (!_specialQuestsCache) _specialQuestsCache = await fetchSpecialQuests();
  const quests = _specialQuestsCache;
  const done = player.specialQuestsDone || [];
  if (!quests.length) {
    el.innerHTML = '<div style="color:#888;text-align:center;padding:20px">Специальных квестов пока нет</div>';
    return;
  }
  let html = '';
  quests.forEach(q => {
    const isDone = done.includes(q._id);
    const isPending = _specialQuestPending.has(String(q._id));
    const icon = q.icon || '⭐';
    const rewardParts = [];
    if (q.reward.gold)  rewardParts.push(iconHTML('coin',12,'#f1c40f') + q.reward.gold);
    if (q.reward.xp)    rewardParts.push(iconHTML('star',12,'#f1c40f') + q.reward.xp + ' XP');
    if (q.reward.nexum) rewardParts.push('💎' + q.reward.nexum + ' Nexum');
    const rewardStr = rewardParts.join(' · ');
    const typeLabel = q.type === 'subscribe' ? 'Подписаться' : q.type === 'link' ? 'Перейти' : 'Выполнить';
    if (isDone) {
      html += `<div class="quest-item quest-done">
        <div class="quest-header">
          <span class="quest-title">${icon} ${q.title}</span>
          <span class="quest-reward">${rewardStr}</span>
        </div>
        ${q.desc ? `<div class="quest-desc">${q.desc}</div>` : ''}
        <div class="quest-prog" style="color:#2ecc71">✓ Выполнено</div>
      </div>`;
    } else if (isPending) {
      html += `<div class="quest-item quest-current">
        <div class="quest-header">
          <span class="quest-title">${icon} ${q.title}</span>
          <span class="quest-reward">${rewardStr}</span>
        </div>
        ${q.desc ? `<div class="quest-desc">${q.desc}</div>` : ''}
        <button class="quest-claim-btn" disabled style="opacity:0.6">Отправка...</button>
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
    if (reward.gold)  { player.gold = (player.gold || 0) + reward.gold; }
    if (reward.xp && typeof gainXP === 'function') gainXP(reward.xp, true);
    if (reward.nexum) window._nexumBalance = (window._nexumBalance || 0) + reward.nexum;
  }
  if (typeof updateHUD === 'function') updateHUD();
  if (_activeQuestTab === 'special') updateSpecialQuestUI();
  if (!alreadyDone) {
    questNotif = { title: '✓ Специальный квест выполнен!', timer: 3.5 };
    if (typeof spawnBurst === 'function' && player) spawnBurst(player.x, player.y, '#fd0', 12);
  }
  // Sync specialQuestsDone to server immediately so the next autosave can't
  // overwrite it with a stale snapshot that predates this completion.
  if (typeof netSaveProgress === 'function') netSaveProgress();
}

// ── HTML quest panel ──────────────────────────────────────
function _questProgHtml(q, isCur) {
  if (!isCur) return '';
  const complete = isQuestComplete(q);
  if (complete) return `<button class="quest-claim-btn" onclick="claimQuest()">Забрать награду</button>`;

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
    return `<div class="quest-prog">Уровень ${player.lvl}/${q.level}
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
  }
  if (q.type === 'buy_potion') {
    const done = player.questKills['_potion'] || 0;
    return `<div class="quest-prog">${done}/${q.count} куплено
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${Math.min(100,Math.round(done/q.count*100))}%"></div></div></div>`;
  }
  if (q.type === 'dungeon_clear') {
    const done = player.questKills['_dungeon_' + q.floor] || 0;
    return `<div class="quest-prog">${done}/${q.count} раз
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${Math.min(100,Math.round(done/q.count*100))}%"></div></div></div>`;
  }
  if (q.type === 'join_guild') {
    return `<button class="quest-claim-btn" style="background:linear-gradient(135deg,#1a3a6a,#2a5aaa)" onclick="onJoinGuild();updateQuestUI()">Вступить в гильдию</button>`;
  }
  if (q.type === 'goto_floor') {
    return `<div class="quest-prog">Перейди на этаж ${q.targetFloor} через Карту</div>`;
  }
  if (q.type === 'craft') {
    return `<div class="quest-prog">Зайди к кузнецу</div>`;
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
    // Floor section is locked if player hasn't reached its first quest yet
    const floorLocked = player.questIdx < firstIdx;

    if (floorLocked) {
      html += `<div class="quest-floor-teaser">🔒 Откроется на ${floorNum} этаже · ещё ${floorQuests.length} квестов</div>`;
      return;
    }

    const doneCnt = Math.min(player.questIdx - firstIdx, floorQuests.length);
    html += `<div class="quest-floor-hdr">Этаж ${floorNum} · <span style="color:#888;font-weight:normal">${doneCnt}/${floorQuests.length} выполнено</span></div>`;

    floorQuests.forEach(({ q, i }) => {
      const isDone = i < player.questIdx;
      const isCur  = i === player.questIdx;
      const cls    = isDone ? 'quest-item quest-done' : isCur ? 'quest-item quest-current' : 'quest-item quest-locked';
      const rewardStr = [
        q.reward.xp > 0 ? iconHTML('star',12,'#f1c40f') + q.reward.xp + ' XP' : '',
        iconHTML('coin',12,'#f1c40f') + q.reward.gold,
      ].filter(Boolean).join(' · ');
      const statusIcon = isDone
        ? iconHTML('hpPlus', 14, '#2ecc71')
        : isCur ? iconHTML('star', 14, '#fd0') : iconHTML('skull', 14, '#555');

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
