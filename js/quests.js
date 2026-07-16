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
    // Grant rewards
    if (q.reward.xp > 0) gainXP(q.reward.xp);
    player.gold += q.reward.gold;
    showQuestComplete(q);
    // Advance
    player.questIdx++;
    player.questKills = {};
    netSaveProgress();
    if (activeTab === 3) updateQuestUI();
  }
}

function showQuestComplete(q) {
  questNotif = { title: '✅ ' + q.title, timer: 3.5 };
  dmgNum(player.x, player.y - 54, '📋 Квест выполнен!', '#fd0');
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

// ── Canvas quest tracker (bottom-left overlay) ────────────
function drawQuestTracker() {
  const q = getCurrentQuest();
  if (!q) return;

  const pad = 10, lineH = 15;
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

  const trackerW = 160, trackerH = pad * 2 + lineH + lines.length * lineH;
  const tx = 8, ty = H - NAV_H - trackerH - 8;

  ctx.save();
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = 'rgba(8,5,20,0.92)';
  ctx.beginPath();
  ctx.roundRect(tx, ty, trackerW, trackerH, 7);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.font = 'bold 10px system-ui, Arial';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fd0';
  ctx.fillText('📋 ' + q.title, tx + pad, ty + pad + 10);

  ctx.font = '9px system-ui, Arial';
  ctx.fillStyle = '#ccc';
  lines.forEach((ln, i) => {
    ctx.fillText(ln, tx + pad, ty + pad + lineH + (i + 1) * lineH - 2);
  });

  // notif banner
  if (questNotif) {
    const alpha = Math.min(1, questNotif.timer, 3.5 - questNotif.timer + 0.5);
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = 'rgba(20,16,50,0.95)';
    ctx.beginPath();
    ctx.roundRect(W / 2 - 120, HEADER_H + 12, 240, 32, 8);
    ctx.fill();
    ctx.font = 'bold 13px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fd0';
    ctx.fillText(questNotif.title, W / 2, HEADER_H + 33);
    ctx.globalAlpha = 1;
  }

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
      if (q.type === 'kill') {
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
        const pct = Math.min(100, Math.round(player.lvl / q.level * 100));
        progHtml = `<div class="quest-prog">Уровень ${player.lvl}/${q.level}
          <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
      } else if (q.type === 'buy_potion') {
        const done = player.questKills['_potion'] || 0;
        progHtml = `<div class="quest-prog">${done}/${q.count} куплено</div>`;
      } else if (q.type === 'craft') {
        progHtml = `<div class="quest-prog">Зайди к кузнецу</div>`;
      }
    }

    const rewardStr = [q.reward.xp > 0 ? `⭐${q.reward.xp} опыта` : '', `💰${q.reward.gold}`].filter(Boolean).join(' · ');

    return `<div class="${cls}">
      <div class="quest-header">
        <span class="quest-title">${isDone ? '✅' : isCur ? '🔸' : '🔒'} ${q.title}</span>
        <span class="quest-reward">${rewardStr}</span>
      </div>
      <div class="quest-desc">${q.desc}</div>
      ${progHtml}
    </div>`;
  }).join('');
}
