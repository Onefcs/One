#!/usr/bin/env node
'use strict';

// Кто пользовался дырами. Только ЧИТАЕТ базу — ничего не меняет и никого не
// банит: решение по каждому аккаунту остаётся за владельцем.
//
//   MONGODB_URI=... node dev/suspects.js            весь список, по убыванию
//   MONGODB_URI=... node dev/suspects.js --top 20   только первые 20
//   MONGODB_URI=... node dev/suspects.js --tid 123  разбор одного аккаунта
//
// Зачем это нужно отдельно от фикса: закрытая дыра перестаёт выдавать новое,
// но всё, что уже надуплено, лежит в savedData как настоящее имущество —
// перепись предметов (_itemCensus) сравнивает сейв с текущим состоянием
// аккаунта, а не с тем, что он заработал честно. Откатывать вслепую нельзя:
// у большинства эти же предметы получены нормально. Поэтому здесь — улики,
// а не приговор.
//
// На чём основаны признаки:
//   • forged_save / forged_select — сервер прямо поймал попытку подделки
//     (save_items_forged / select_items_forged в PlayerLog). Самый твёрдый
//     признак: честному клиенту неоткуда их взять.
//   • progress_clamped — защита прогресса срезала заявленное золото/уровень.
//   • craft_vs_kills — много крафтов при мизерном числе убийств. Материалы
//     падают только с мобов, так что крафтить сильно больше, чем убивать,
//     обычным путём нельзя.
//   • gold_vs_kills — золота больше, чем могли дать убийства. За убийство
//     платят goldAtLevel() = уровень моба, то есть максимум ~60 монет, а с
//     учётом клана и зелья ×2 — потолок в ~150 на убийство. Порог здесь
//     заведомо выше, чтобы не цеплять тех, кто копил и продавал.
//   • lvl_vs_kills — уровень, не подкреплённый убийствами.
//   • mats — запасы материалов, несопоставимые с убийствами.

const path = require('path');
const mongoose = require('mongoose');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return (i >= 0 && argv[i + 1]) ? argv[i + 1] : d; };

if (has('--help') || has('-h')) {
  const lines = require('fs').readFileSync(__filename, 'utf8').split('\n');
  const start = lines.findIndex(l => l.startsWith('//'));
  const end = lines.findIndex((l, i) => i > start && !l.startsWith('//'));
  console.log(lines.slice(start, end).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const URI = process.env.MONGODB_URI || val('--uri', '');
if (!URI) {
  console.error('\n  Нужен MONGODB_URI (или --uri). Пример:\n' +
                '    MONGODB_URI="mongodb+srv://..." node dev/suspects.js --top 20\n');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PlayerModel    = require(path.join(ROOT, 'server/models/Player'));
const PlayerLogModel = require(path.join(ROOT, 'server/models/PlayerLog'));

// Потолок золота за одно убийство: goldAtLevel() = уровень моба (глубже
// шестидесятого их нет), ×1.2 клан, ×2 зелье — это ~150. Берём вдвое больше,
// чтобы наверняка не задеть боссов и событийные выплаты.
const GOLD_PER_KILL_MAX = 300;
// Материалов на убийство. Реальный дроп — доли процента (рецепты) и единицы
// процентов (ключи, камни), так что пятёрка завышена в сотни раз. Важно:
// материалы ещё и ПОКУПАЮТ — паки в GRAM-магазине и VIP-награды выдают их
// пачками, так что один этот признак ничего не доказывает у платящего игрока.
const MATS_PER_KILL_MAX = 5;
// Ниже этого числа убийств аккаунт просто новый — считать его подозрительным
// не за что, у него ещё ничего и нет.
const MIN_KILLS_TO_JUDGE = 50;

const _num = v => Math.max(0, Math.floor(Number(v) || 0));

// Суммарный уровень, который оправдан числом убийств: одно убийство даёт
// xpAtLevel(уровень моба) опыта, но нам хватит грубой верхней оценки — если
// уровень выше, чем дало бы даже самое щедрое допущение, это видно сразу.
function lvlPlausible(lvl, kills) {
  if (lvl <= 5) return true;
  // Опыта за убийство дают xpAtLevel() = уровень моба, максимум ~60; с зельем
  // ×2 и кланом это ~150. Считаем по 1500 на убийство — вдесятеро больше
  // потолка, с запасом на боссов и на ×10 множитель Страха, чтобы сюда
  // попадал только заведомо недостижимый уровень.
  let need = 0;
  for (let l = 1; l < lvl; l++) {
    const base = Math.floor(100 * Math.pow(1.38, l - 1));
    let m = l > 5 ? 3 : 1;
    if (l > 20) m *= 1.6;
    need += Math.floor(base * m);
  }
  return kills * 1500 >= need;
}

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  console.log('подключено\n');

  const players = await PlayerModel.find({}, 'telegramId username bm banned savedData createdAt').lean();

  // Улики из логов — одним запросом на всех, а не по игроку.
  const EVENTS = ['save_items_forged', 'select_items_forged', 'progress_clamped', 'inv:gear_craft',
                  'inv:class_gear_craft', 'inv:pet_craft', 'inv:mat_upgrade', 'inv:box_craft'];
  const logRows = await PlayerLogModel.aggregate([
    { $match: { event: { $in: EVENTS } } },
    { $group: { _id: { tid: '$telegramId', ev: '$event' }, n: { $sum: 1 } } },
  ]);
  const byTid = new Map();
  for (const r of logRows) {
    const m = byTid.get(r._id.tid) || {};
    m[r._id.ev] = r.n;
    byTid.set(r._id.tid, m);
  }

  const rows = [];
  for (const p of players) {
    const sd = p.savedData || {};
    const kills = _num(sd.kills);
    const gold  = _num(sd.gold);
    const lvl   = Math.max(1, _num(sd.lvl) || 1);
    const ev    = byTid.get(p.telegramId) || {};

    const items = [...(Array.isArray(sd.inventory) ? sd.inventory : []),
                   ...(Array.isArray(sd.storage) ? sd.storage : [])];
    const mats = items.reduce((s, i) => s + (i && (i.slot === 'material' || i.slot === 'recipe') ? _num(i.qty) || 1 : 0), 0);
    const crafts = (ev['inv:gear_craft'] || 0) + (ev['inv:class_gear_craft'] || 0) +
                   (ev['inv:pet_craft'] || 0) + (ev['inv:mat_upgrade'] || 0) + (ev['inv:box_craft'] || 0);

    const flags = [];
    let score = 0;
    if (ev.save_items_forged)   { flags.push(`forged_save×${ev.save_items_forged}`);     score += 100; }
    if (ev.select_items_forged) { flags.push(`forged_select×${ev.select_items_forged}`); score += 100; }
    if (ev.progress_clamped)    { flags.push(`progress_clamped×${ev.progress_clamped}`); score += 80; }

    if (kills >= MIN_KILLS_TO_JUDGE) {
      const goldCap = kills * GOLD_PER_KILL_MAX;
      if (gold > goldCap) { flags.push(`gold ${gold} > ${goldCap} за ${kills} уб.`); score += 60; }
      const matCap = kills * MATS_PER_KILL_MAX;
      if (mats > matCap)  { flags.push(`материалов ${mats} > ${matCap} (проверьте покупки)`); score += 25; }
      if (!lvlPlausible(lvl, kills)) { flags.push(`lvl ${lvl} при ${kills} уб.`);    score += 40; }
      if (crafts > kills / 10 && crafts > 20) { flags.push(`крафтов ${crafts} при ${kills} уб.`); score += 40; }
    } else if (gold > 100000 || lvl > 10 || mats > 500) {
      // Почти без убийств, но уже богат — так не бывает.
      flags.push(`${kills} уб., но gold=${gold} lvl=${lvl} материалов=${mats}`);
      score += 90;
    }

    if (score > 0) {
      rows.push({ tid: p.telegramId, name: p.username, banned: !!p.banned,
                  score, lvl, kills, gold, mats, crafts, bm: p.bm || 0, flags });
    }
  }

  rows.sort((a, b) => b.score - a.score);

  const one = val('--tid', '');
  if (one) {
    const r = rows.find(x => x.tid === String(one));
    const p = players.find(x => x.telegramId === String(one));
    if (!p) { console.log('аккаунт не найден'); await mongoose.disconnect(); return; }
    console.log(`${p.username} (${p.telegramId})${p.banned ? '  [ЗАБАНЕН]' : ''}`);
    const sd = p.savedData || {};
    console.log(`  lvl=${_num(sd.lvl)} kills=${_num(sd.kills)} gold=${_num(sd.gold)} bm=${p.bm || 0}`);
    console.log(`  GRAM=${sd.gramBalance || 0}  Liberty=${sd.nexumBalance || 0}`);
    console.log(`  подозрений: ${r ? r.flags.join('; ') : 'нет'}`);
    const logs = await PlayerLogModel.find({ telegramId: String(one) }).sort({ at: -1 }).limit(40).lean();
    console.log('\n  последние 40 записей лога:');
    for (const l of logs) console.log(`    ${new Date(l.at).toISOString()}  ${l.event}  ${JSON.stringify(l.meta || {})}`);
    await mongoose.disconnect();
    return;
  }

  const top = Number(val('--top', 0)) || rows.length;
  console.log(`подозрительных аккаунтов: ${rows.length} из ${players.length}\n`);
  console.log('  очки  игрок                 lvl   убийств      золото  матер.  крафтов  признаки');
  console.log('  ' + '─'.repeat(110));
  for (const r of rows.slice(0, top)) {
    const name = (r.name || '').slice(0, 20).padEnd(20);
    console.log(`  ${String(r.score).padStart(4)}  ${name} ${String(r.lvl).padStart(4)}  ` +
                `${String(r.kills).padStart(8)}  ${String(r.gold).padStart(10)}  ` +
                `${String(r.mats).padStart(6)}  ${String(r.crafts).padStart(7)}  ${r.flags.join('; ')}`);
    console.log(`        tid=${r.tid}${r.banned ? '   [ЗАБАНЕН]' : ''}`);
  }
  console.log('\n  Разбор одного: node dev/suspects.js --tid <telegramId>');
  console.log('  Очки — это порядок разбора, а не доказательство. Смотрите лог аккаунта.');
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
