#!/usr/bin/env node
//
// Проверка семантики MongoDB, на которую опирается переход балансов (GRAM /
// Liberty) с абсолютного $set на атомарный $inc.
//
// Зачем: аудит показал, что все 20 путей начисления валюты, кроме одного,
// написаны как read-modify-write через await над общим значением —
//
//     base   = кэш ?? БД
//     newBal = base + amount
//     await updateOne({ $set: { 'savedData.gramBalance': newBal } })
//     кэш.set(newBal)
//
// — и две операции, попавшие в одно окно, затирают друг друга. Симуляция это
// воспроизводит, но симуляция не проверяет поведение самой БД. Этот скрипт
// проверяет именно его, на настоящей MongoDB.
//
// Запуск:
//     MONGODB_URI="mongodb://.../имя_базы" node scripts/verify-balances.js
//
// Безопасность: работает в отдельной коллекции _balance_probe, которую создаёт
// и удаляет сам. Коллекции players/clans/marketlistings не открываются вообще —
// ниже стоит проверка, которая падает, если имя коллекции не совпало с пробной.
// Тем не менее запускать лучше на стейджинге, а не на бою.

const mongoose = require('mongoose');

const URI = process.env.MONGODB_URI;
if (!URI) {
  console.error('Нужна переменная MONGODB_URI. Пример:\n  MONGODB_URI="mongodb://127.0.0.1:27017/probe" node scripts/verify-balances.js');
  process.exit(2);
}

const PROBE = '_balance_probe';
let fails = 0;
const ok = (cond, msg) => { console.log(cond ? '  ✓ ' + msg : '  ✗ FAIL: ' + msg); if (!cond) fails++; };

// Форма документа повторяет реальную: баланс лежит во вложенном savedData,
// то есть все обновления идут по точечному пути. Это отдельно важно — на
// null-родителе точечный $set/$inc падает, и на этом уже спотыкались (см.
// инициализацию savedData при логине в server/index.js).
const Probe = mongoose.model(PROBE, new mongoose.Schema({
  telegramId: { type: String, unique: true },
  savedData:  { type: mongoose.Schema.Types.Mixed, default: null },
}, { collection: PROBE }));

const reset = async (savedData) => {
  await Probe.deleteMany({});
  await Probe.create({ telegramId: 'u1', savedData });
};
const balOf = async () => (await Probe.findOne({ telegramId: 'u1' }).lean())?.savedData?.gramBalance;

async function main() {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 10000 });
  const dbName = mongoose.connection.name;
  console.log(`\n  база: ${dbName}   коллекция: ${PROBE}\n`);

  // Страховка: ниже идут deleteMany, и они не должны уехать в реальные данные.
  if (Probe.collection.collectionName !== PROBE) {
    console.error('Имя коллекции не совпало с пробным — прерываю, чтобы не тронуть реальные данные.');
    process.exit(2);
  }

  console.log('=== 1. $inc по точечному пути внутри savedData ===');
  {
    await reset({ gramBalance: 100 });
    await Probe.updateOne({ telegramId: 'u1' }, { $inc: { 'savedData.gramBalance': 25 } });
    ok(await balOf() === 125, `100 + $inc 25 = ${await balOf()} (ожидалось 125)`);
    await Probe.updateOne({ telegramId: 'u1' }, { $inc: { 'savedData.gramBalance': -30 } });
    ok(await balOf() === 95, `125 + $inc −30 = ${await balOf()} (ожидалось 95)`);
  }

  console.log('\n=== 2. $inc по отсутствующему полю и по null-родителю ===');
  {
    await reset({ gold: 5 });                       // gramBalance ещё нет
    await Probe.updateOne({ telegramId: 'u1' }, { $inc: { 'savedData.gramBalance': 7 } });
    ok(await balOf() === 7, `$inc по отсутствующему полю создаёт его = ${await balOf()} (ожидалось 7)`);
    const doc = await Probe.findOne({ telegramId: 'u1' }).lean();
    ok(doc.savedData.gold === 5, 'соседние поля savedData не затронуты');

    await reset(null);                              // savedData === null
    let threw = null;
    try { await Probe.updateOne({ telegramId: 'u1' }, { $inc: { 'savedData.gramBalance': 7 } }); }
    catch (e) { threw = e.message.split('\n')[0]; }
    // Ожидаем ошибку: точечный путь по null-родителю не создаётся. Логин уже
    // инициализирует savedData в {}, но если это когда-нибудь уберут — сюда.
    ok(threw !== null, `на null-родителе $inc падает, как и ожидалось (${threw ? 'ошибка есть' : 'ОШИБКИ НЕТ — проверить инициализацию savedData'})`);
  }

  console.log('\n=== 3. Условное списание ($gte + modifiedCount) ===');
  {
    await reset({ gramBalance: 100 });
    const r1 = await Probe.updateOne(
      { telegramId: 'u1', 'savedData.gramBalance': { $gte: 80 } },
      { $inc: { 'savedData.gramBalance': -80 } });
    ok(r1.modifiedCount === 1 && await balOf() === 20,
       `списание 80 при балансе 100 прошло, остаток ${await balOf()}`);
    const r2 = await Probe.updateOne(
      { telegramId: 'u1', 'savedData.gramBalance': { $gte: 80 } },
      { $inc: { 'savedData.gramBalance': -80 } });
    ok(r2.modifiedCount === 0 && await balOf() === 20,
       `повторное списание 80 при остатке 20 отклонено (modifiedCount=${r2.modifiedCount}), баланс не изменился`);
  }

  console.log('\n=== 4. Гонка: два параллельных списания ===');
  {
    // Без условия в запросе обе операции проходят проверку по своей копии
    // и уводят баланс в минус — ровно то, чего боятся при переходе на $inc.
    await reset({ gramBalance: 100 });
    const naive = async (amt) => {
      const cur = await balOf();                              // читает 100
      if (cur < amt) return 'отказ';
      await Probe.updateOne({ telegramId: 'u1' }, { $inc: { 'savedData.gramBalance': -amt } });
      return 'ок';
    };
    const rn = await Promise.all([naive(80), naive(80)]);
    const naiveBal = await balOf();
    ok(naiveBal < 0, `без условия: ${rn.join(', ')} → баланс ${naiveBal} (минус ожидаем — так делать НЕЛЬЗЯ)`);

    await reset({ gramBalance: 100 });
    const guarded = async (amt) => {
      const r = await Probe.updateOne(
        { telegramId: 'u1', 'savedData.gramBalance': { $gte: amt } },
        { $inc: { 'savedData.gramBalance': -amt } });
      return r.modifiedCount === 1 ? 'ок' : 'отказ';
    };
    const rg = await Promise.all([guarded(80), guarded(80)]);
    const guardedBal = await balOf();
    ok(guardedBal === 20 && rg.filter(x => x === 'ок').length === 1,
       `с условием: ${rg.join(', ')} → баланс ${guardedBal} (ожидалось 20, ровно одно списание)`);
  }

  console.log('\n=== 5. Гонка из аудита: начисление против записи абсолютного значения ===');
  {
    // Как сейчас: обе стороны пишут "сколько всего", и та, что легла второй,
    // стирает первую.
    await reset({ gramBalance: 100 });
    const depositSet = (async () => {
      const base = await balOf();                             // 100
      await new Promise(r => setTimeout(r, 40));              // окно
      await Probe.updateOne({ telegramId: 'u1' }, { $set: { 'savedData.gramBalance': base + 50 } });
    })();
    const flushSet = (async () => {
      const stale = 100;                                      // значение, прочитанное до депозита
      await new Promise(r => setTimeout(r, 60));
      await Probe.updateOne({ telegramId: 'u1' }, { $set: { 'savedData.gramBalance': stale } });
    })();
    await Promise.all([depositSet, flushSet]);
    const setBal = await balOf();
    ok(setBal === 100, `через $set депозит 50 потерян: баланс ${setBal} (воспроизводит баг из аудита)`);

    // Как предлагается: обе стороны пишут "на сколько изменилось".
    await reset({ gramBalance: 100 });
    await Promise.all([
      (async () => { await new Promise(r => setTimeout(r, 40));
        await Probe.updateOne({ telegramId: 'u1' }, { $inc: { 'savedData.gramBalance': 50 } }); })(),
      (async () => { await new Promise(r => setTimeout(r, 60));
        await Probe.updateOne({ telegramId: 'u1' }, { $inc: { 'savedData.gramBalance': 0 } }); })(),
    ]);
    const incBal = await balOf();
    ok(incBal === 150, `через $inc депозит сохраняется: баланс ${incBal} (ожидалось 150)`);
  }

  console.log('\n=== 6. Точность: 7 знаков после запятой при многократном $inc ===');
  {
    // Дроп GRAM — 0.0000001 за уровень моба. Сейчас каждое изменение проходит
    // через _round7(); при $inc округлять негде, поэтому проверяем, что дрейф
    // остаётся ниже отображаемого знака.
    await reset({ gramBalance: 1234.5678901 });
    const N = 2000, DROP = 0.0000001;
    for (let i = 0; i < N; i++) {
      await Probe.updateOne({ telegramId: 'u1' }, { $inc: { 'savedData.gramBalance': DROP } });
    }
    const got = await balOf();
    const want = 1234.5678901 + N * DROP;
    const drift = Math.abs(got - want);
    ok(drift < 1e-7, `${N} дропов: ${got.toFixed(10)} против точного ${want.toFixed(10)}, дрейф ${drift.toExponential(2)} (порог 1e-7)`);
  }

  console.log('\n=== 7. findOneAndUpdate возвращает значение после изменения ===');
  {
    // Кэш должен заполняться тем, что вернула БД, иначе он снова разъедется.
    await reset({ gramBalance: 10 });
    const upd = await Probe.findOneAndUpdate(
      { telegramId: 'u1' },
      { $inc: { 'savedData.gramBalance': 5 } },
      { new: true }).select('savedData.gramBalance').lean();
    ok(upd?.savedData?.gramBalance === 15,
       `{new:true} вернул баланс после изменения: ${upd?.savedData?.gramBalance} (ожидалось 15)`);
  }

  await Probe.collection.drop().catch(() => {});
  await mongoose.connection.close();

  console.log(fails === 0
    ? '\n  ВСЁ ПРОШЛО — переход на $inc безопасен на этой версии MongoDB\n'
    : `\n  ${fails} проверок не прошло — разбираться до миграции\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n  Скрипт упал:', err.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(2);
});
