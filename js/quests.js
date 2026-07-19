// ─────────────────────────────────────────────────────────
//  QUEST SYSTEM
// ─────────────────────────────────────────────────────────
let questNotif = null; // { title, timer }

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
  if (q.type === 'level') return { done: player.lvl, total: q.level };
  if (q.type === 'buy_potion') return { done: player.questKills['_potion'] || 0, total: q.count };
  if (q.type === 'craft') return { done: player.questKills['_craft'] || 0, total: 1 };
  return {};
}

function isQuestComplete(q) {
  if (!player || !q) return false;
  if (q.type === 'kill') {
    return q.enemies.every(name => (player.questKills[name] || 0) >= q.count);
  }
  if (q.type === 'kill_multi') {
    return q.enemies.every(name => (player.questKills[name] || 0) >= q.count);
  }
  if (q.type === 'level') return player.lvl >= q.level;
  if (q.type === 'buy_potion') return (player.questKills['_potion'] || 0) >= q.count;
  if (q.type === 'craft') return (player.questKills['_craft'] || 0) >= 1;
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

// ── HTML quest panel ──────────────────────────────────────
function updateQuestUI() {
  const el = document.getElementById('quest-list');
  if (!el || !player) return;

  el.innerHTML = QUEST_DEF.map((q, i) => {
    const isDone = i < player.questIdx;
    const isCur  = i === player.questIdx;
    const cls    = isDone ? 'quest-item quest-done' : isCur ? 'quest-item quest-current' : 'quest-item quest-locked';

    let progHtml = '';
    if (isCur) {
      const complete = isQuestComplete(q);
      if (complete) {
        progHtml = `<button class="quest-claim-btn" onclick="claimQuest()">Забрать награду</button>`;
      } else if (q.type === 'kill') {
        const done = q.enemies.reduce((s, n) => s + (player.questKills[n] || 0), 0);
        const pct  = Math.min(100, Math.round(done / q.count * 100));
        progHtml = `<div class="quest-prog">${done}/${q.count}
          <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
      } else if (q.type === 'kill_multi') {
        progHtml = q.enemies.map(name => {
          const done = player.questKills[name] || 0;
          const pct  = Math.min(100, Math.round(done / q.count * 100));
          return `<div class="quest-prog">${name}: ${done}/${q.count}
            <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
        }).join('');
      } else if (q.type === 'level') {
        const pct = Math.min(100, Math.round(player.lvl / (q.level || 1) * 100));
        progHtml = `<div class="quest-prog">Уровень ${player.lvl}/${q.level}
          <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
      } else if (q.type === 'buy_potion') {
        const done = player.questKills['_potion'] || 0;
        progHtml = `<div class="quest-prog">${done}/${q.count} куплено</div>`;
      } else if (q.type === 'craft') {
        progHtml = `<div class="quest-prog">Зайди к кузнецу</div>`;
      }
    }

    const rewardStr = [
      q.reward.xp > 0 ? iconHTML('star',12,'#f1c40f') + q.reward.xp + ' опыта' : '',
      iconHTML('coin',12,'#f1c40f') + q.reward.gold,
    ].filter(Boolean).join(' · ');
    const statusIcon = isDone
      ? iconHTML('hpPlus', 14, '#2ecc71')
      : isCur ? iconHTML('star', 14, '#fd0') : iconHTML('skull', 14, '#555');

    return `<div class="${cls}">
      <div class="quest-header">
        <span class="quest-title">${statusIcon} ${q.title}</span>
        <span class="quest-reward">${rewardStr}</span>
      </div>
      <div class="quest-desc">${q.desc}</div>
      ${progHtml}
    </div>`;
  }).join('');
}
