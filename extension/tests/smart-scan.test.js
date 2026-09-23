const test = require('node:test');
const assert = require('node:assert/strict');
require('../formula-engine.js');
const S = require('../smart-scan.js');

function days(n, { close=1000, drift=0, valueB=100, bigB=null, realB=0 } = {}){
  return Array.from({length:n}, (_,i)=>({ key:String(20260101+i), close:close*(1+drift*i), valueB, ...(bigB===null?{}:{bigB, realB}) }));
}
const row = (o) => ({ insCode:o.k, symbol:o.k, hasClient:true, valueB:100, lastPrice:1000, lastPercent:0, realMoneyB:0, bigMoneyB:0, bigBuyB:0, bigSellB:0, ...o });

test('session fraction scales intraday value against a full average day', () => {
  assert.equal(S.sessionFraction(90000), 0.15);
  assert.equal(S.sessionFraction(104500), 0.5);
  assert.equal(S.sessionFraction(130000), 1);
});

test('features normalize flows by traded value and use own history', () => {
  const f = S.symbolFeatures(row({ k:'a', valueB:200, bigMoneyB:30, bigBuyB:30, realMoneyB:20 }),
    days(25, { valueB:100, bigB:1, realB:1 }), { sessionFraction:1 });
  assert.equal(f.bigPct, 15);
  assert.equal(f.realPct, 10);
  assert.equal(f.valueRatio, 2);
  assert.equal(f.streak, 26);
  assert.ok(f.big5Pct > 0 && f.bigZ === null); // flat history → std 0 → no z
});

test('scan ranks consistent big inflow with uptrend above a random symbol and flags outflow', () => {
  const rows = [
    row({ k:'up', valueB:300, bigMoneyB:45, bigBuyB:45, realMoneyB:40, lastPrice:1600, lastPercent:3 }),
    row({ k:'flat', valueB:100, bigMoneyB:2, bigBuyB:2, realMoneyB:1, lastPrice:1000 }),
    row({ k:'down', valueB:150, bigMoneyB:-30, bigSellB:30, realMoneyB:-25, lastPrice:600, lastPercent:-3 }),
    row({ k:'tiny', valueB:2, bigMoneyB:2 }),
  ];
  const hist = {
    up: days(60, { drift:0.01, bigB:5, realB:4 }),
    flat: days(60, { bigB:0.5, realB:0 }),
    down: days(60, { drift:-0.005, bigB:-5, realB:-4 }),
  };
  const r = S.scan(rows, hist, { hms:130000 });
  assert.equal(r.inflow[0].k ?? r.inflow[0].row.k, 'up');
  assert.ok(!r.inflow.some(x=>x.row.k==='tiny'), 'illiquid symbol excluded');
  assert.equal(r.outflow[0].row.k, 'down');
  assert.ok(r.inflow[0].inReasons.some(s=>s.includes('پیاپی')));
});
