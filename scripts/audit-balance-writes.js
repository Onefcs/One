// Статическая проверка инварианта миграции: savedData.gramBalance и
// savedData.nexumBalance меняются ТОЛЬКО через $inc внутри _balanceAdd /
// _balanceSpend. Один забытый абсолютный $set тихо возвращает потерю денег,
// поэтому это проверяется автоматически, а не глазами.
const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','server','index.js'),'utf8');
const lines=src.split('\n');
let fails=0; const ok=(c,m)=>{console.log(c?'  ✓ '+m:'  ✗ FAIL: '+m); if(!c) fails++;};

const strip = l => l.replace(/\/\/.*$/,'');
const hits = (re, label) => {
  const out=[];
  lines.forEach((l,i)=>{ if(re.test(strip(l))) out.push(`${i+1}: ${l.trim().slice(0,110)}`); });
  return out;
};

console.log('\n=== инвариант: баланс меняется только через $inc ===\n');

// 1. Абсолютный $set баланса где угодно
const absSet = hits(/\$set[\s\S]*savedData\.(gram|nexum)Balance|'savedData\.(gram|nexum)Balance'\s*:(?!\s*\{\s*\$)/);
const absSetReal = absSet.filter(h => !/\$inc|\$gte|sort|select|find/.test(h));
ok(absSetReal.length===0, `абсолютных $set баланса: ${absSetReal.length}` + (absSetReal.length?'\n      '+absSetReal.join('\n      '):''));

// 2. Балансы не входят в общие записи savedData
const inBlob = hits(/(gram|nexum)Balance:\s*_live(Gram|Nexum)\(\)/);
ok(inBlob.length===0, `баланс в составе общей записи savedData: ${inBlob.length}` + (inBlob.length?'\n      '+inBlob.join('\n      '):''));

// 3. $inc по балансу встречается только внутри примитивов
const incLines=[];
lines.forEach((l,i)=>{ if(/\$inc[\s\S]*savedData\.\$\{|\$inc/.test(strip(l)) && /savedData\.\$\{field\}|savedData\.(gram|nexum)Balance/.test(strip(l))) incLines.push(i+1); });
const addStart=src.slice(0,src.indexOf('async function _balanceAdd')).split('\n').length;
const spendEnd=src.slice(0,src.indexOf('async function _balanceOf')).split('\n').length;
const outside=incLines.filter(n=>n<addStart||n>spendEnd);
ok(outside.length===0, `$inc по балансу вне примитивов: ${outside.length}` + (outside.length?` (строки ${outside.join(', ')})`:''));

// 4. Каждое списание проверяет отказ
// Диапазон самих примитивов исключаем — внутри них есть собственные упоминания
const primFrom=src.slice(0,src.indexOf('async function _balanceAdd')).split('\n').length;
const primTo=src.slice(0,src.indexOf('const _BALANCE_CACHES')+src.slice(src.indexOf('const _BALANCE_CACHES')).indexOf('\n// Keep in sync')).split('\n').length;
const spendCalls=[];
lines.forEach((l,i)=>{ const n=i+1; if(n>=primFrom&&n<=primTo) return;
  if(/_balanceSpend\(/.test(strip(l))) spendCalls.push(n); });
const unchecked = spendCalls.filter(n => {
  const win = lines.slice(n-1, n+4).join('\n');
  return !/=== null|!== null|== null/.test(win);
});
ok(spendCalls.length>0 && unchecked.length===0,
   `вызовов _balanceSpend: ${spendCalls.length}, все проверяют отказ` + (unchecked.length?` — БЕЗ проверки: ${unchecked.join(', ')}`:''));

// 5. Старая машинерия удалена
const legacy = hits(/_persistBalancesSoon|_balancesDirty|_flushBalances\b/);
ok(legacy.length===0, `остатков старой машинерии: ${legacy.length}`);

// 6. _setGram/_setNexum — только сид при логине и оптимистичный дроп
const setters=[];
lines.forEach((l,i)=>{ const t=strip(l); if(/_set(Gram|Nexum)\(/.test(t) && !/function _set/.test(t)) setters.push({n:i+1,t:t.trim()}); });
const bad = setters.filter(x => !/doc\.savedData|_liveGram\(\) \+ amount|_liveNexum\(\) \+ amount/.test(x.t));
ok(bad.length===0, `вызовов _setGram/_setNexum: ${setters.length}, все легитимны` + (bad.length?'\n      '+bad.map(x=>x.n+': '+x.t.slice(0,90)).join('\n      '):''));

// 7. Дренаж дропов подключён к падению и к штатному выключению
ok(/uncaughtException[\s\S]{0,600}_flushDrops/.test(src), 'дропы сбрасываются при uncaughtException');
ok(/_gracefulShutdown[\s\S]{0,900}_flushDrops/.test(src), 'дропы сбрасываются при штатном выключении');
ok(/socket\.data\._flushNow[\s\S]{0,400}_flushDrops/.test(src), 'дропы сбрасываются при дисконнекте');

console.log(fails?`\n  ${fails} нарушений инварианта\n`:'\n  ИНВАРИАНТ СОБЛЮДЁН\n');
process.exit(fails?1:0);
