const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../formula-engine.js');

test('unit conversion is applied exactly once', () => {
  assert.equal(F.billionRialToBillionToman(10), 1);
  assert.equal(F.billionRialToBillionToman(20), 2);
});

test('VWAP is preferred to close price for live value approximation', () => {
  assert.equal(F.resolveFlowPriceRial({ tradeValueRial: 2000, volume: 4, closePrice: 700 }), 500);
});

test('historical direct individual values override volume x price', () => {
  const x = F.computeClientMetrics({
    client: { buy_I_Volume:100, sell_I_Volume:80, buy_I_Count:2, sell_I_Count:2, buy_I_Value:2e9, sell_I_Value:1.2e9 },
    priceRial: 999999,
    preferDirectValues: true
  });
  assert.equal(x.individualBuyB, 2);
  assert.equal(x.individualSellB, 1.2);
  assert.ok(Math.abs(x.realMoneyB - 0.8) < 1e-12);
  assert.equal(x.buyAvgOrderB, 1);
  assert.equal(x.sellAvgOrderB, 0.6);
});

test('historical count aliases buy_I_Count/sell_I_Count are recognized', () => {
  const c = F.normalizeClient({ buy_I_Count:7, sell_I_Count:5, buy_I_Volume:70, sell_I_Volume:50 });
  assert.equal(c.buyCountI, 7);
  assert.equal(c.sellCountI, 5);
});

test('estimated large side is bounded by total individual side value', () => {
  for (const avg of [0, 0.5, 1, 3, 6, 20]) {
    const share = F.largeOrderShare(avg, 20);
    assert.ok(share >= 0 && share <= 1);
  }
  const x = F.computeClientMetrics({
    client: { buy_I_Volume:10_000_000, sell_I_Volume:8_000_000, buy_CountI:2, sell_CountI:2 },
    priceRial: 10_000
  });
  assert.ok(x.bigBuyB >= 0 && x.bigBuyB <= x.individualBuyB);
  assert.ok(x.bigSellB >= 0 && x.bigSellB <= x.individualSellB);
});

test('buyer and seller power are reciprocal for positive averages', () => {
  const x = F.computeClientMetrics({
    client: { buy_I_Volume:1000, sell_I_Volume:500, buy_CountI:10, sell_CountI:10 },
    priceRial: 1000
  });
  assert.ok(Math.abs(x.buyPower * x.sellPower - 1) < 1e-12);
});

test('instant delta does not change when only valuation price changes', () => {
  const prev = { buyVolI:1000, sellVolI:900, flowPriceRial:1000, largeBuyShare:.5, largeSellShare:.5 };
  const curr = { buyVolI:1000, sellVolI:900, flowPriceRial:2000, largeBuyShare:.5, largeSellShare:.5 };
  const d = F.intervalFlowDelta(prev, curr);
  assert.equal(d.dRealB, 0);
  assert.equal(d.dBigB, 0);
});

test('negative cumulative delta is treated as reset and suppressed', () => {
  assert.equal(F.intervalFlowDelta({buyVolI:100,sellVolI:100},{buyVolI:90,sellVolI:101,flowPriceRial:1000}), null);
});

test('moving averages require a complete window', () => {
  const v = [1,2,3,4,5,6];
  assert.equal(F.movingAverageAt(v, 3, 5), null);
  assert.equal(F.movingAverageAt(v, 4, 5), 3);
  assert.equal(F.movingAverageAt(v, 5, 5), 4);
});

test('3/5-day net requires distinct complete trading days', () => {
  const days = [
    {key:'20260105',hotB:1}, {key:'20260105',hotB:99},
    {key:'20260104',hotB:2}, {key:'20260103',hotB:3},
    {key:'20260102',hotB:4}, {key:'20260101',hotB:5},
  ];
  assert.equal(F.netWindow(days,3), 6);
  assert.equal(F.netWindow(days,5), 15);
  assert.equal(F.netWindow(days.slice(0,3),3), null);
});

test('adaptive tape threshold uses floor, liquidity and recent quantile', () => {
  assert.equal(F.adaptiveTapeThreshold([], 0), 1);
  assert.equal(F.adaptiveTapeThreshold([], 10_000), 5); // 0.05% of observed day value
  const hist = Array.from({length:20}, (_,i)=>0.2 + i*0.01);
  assert.equal(F.adaptiveTapeThreshold(hist, 0), 1, '100M floor dominates small-tape history');
});

test('2-second tape/clienttype model attributes a strong buy burst to real large money', () => {
  const prev = {
    buyVolI:1000, sellVolI:1000, buyCountI:10, sellCountI:10,
    individualBuyB:10, individualSellB:10, buyValueSource:'official-value', sellValueSource:'official-value',
    buyAvgOrderB:1, sellAvgOrderB:1, volume:10000, valueB:100, tradeCount:100, lastPrice:1000, closePrice:1000
  };
  const curr = {
    buyVolI:1200, sellVolI:1050, buyCountI:11, sellCountI:10,
    individualBuyB:13, individualSellB:10.5, buyValueSource:'official-value', sellValueSource:'official-value',
    buyAvgOrderB:13/11, sellAvgOrderB:1.05, volume:10400, valueB:104, tradeCount:104, lastPrice:1010, closePrice:1005
  };
  const d = F.estimateTapeClientFlow(prev, curr, {historyGrossB:[], previousSide:1, sameSideRun:2});
  assert.equal(d.tapeSide, 1);
  assert.equal(d.qualifies, true);
  assert.ok(d.dBigBuyB >= 2.9 && d.dBigBuyB <= 3.01);
  assert.equal(d.dBigSellB, 0);
  assert.ok(d.confidence >= 0.5);
});

test('fragmented high-turnover retail burst is rejected by concentration guard', () => {
  const prev = {
    buyVolI:1000, sellVolI:1000, buyCountI:10, sellCountI:10,
    individualBuyB:10, individualSellB:10, buyValueSource:'official-value', sellValueSource:'official-value',
    buyAvgOrderB:1, sellAvgOrderB:1, volume:10000, valueB:100, tradeCount:100, lastPrice:1000, closePrice:1000
  };
  const curr = {
    buyVolI:1400, sellVolI:1100, buyCountI:20, sellCountI:12,
    individualBuyB:14, individualSellB:11, buyValueSource:'official-value', sellValueSource:'official-value',
    buyAvgOrderB:.7, sellAvgOrderB:.916, volume:11000, valueB:105, tradeCount:500, lastPrice:1001, closePrice:1000
  };
  const d = F.estimateTapeClientFlow(prev, curr, {historyGrossB:[]});
  assert.equal(d.qualifies, false);
  assert.equal(d.dBigB, 0);
});


(function testCumulativePriorSeed(){
  const m={individualBuyB:100,individualSellB:80,buyAvgOrderB:4,sellAvgOrderB:0.8,buyPower:5,sellPower:0.2};
  const p=F.estimateCumulativeLargePrior(m,{floorB:1,fullB:4});
  if(!(p.bigBuyB>0)) throw new Error('prior should seed large buy');
  if(!(p.bigSellB===0)) throw new Error('below-floor sell should not seed');
  if(!(p.bigMoneyB>0)) throw new Error('prior net should be positive');
})();

test('v8.15 big money follows the SMT "strong real" definition (channel tables)', () => {
  // 10 sellers × 10; buyers: 5×10 + 50 → 40, 5×10 + 2×25 → 30, 6×10 + 40 → 30
  for (const [nb, expected] of [[6, 40], [7, 30]]) {
    const s = F.smartMoneySMT({ buyValueB:100, sellValueB:100, buyCountI:nb, sellCountI:10 });
    assert.ok(Math.abs(s.strongInB - expected) < 1e-9);
    assert.equal(s.strongOutB, 0);
  }
  const out = F.smartMoneySMT({ buyValueB:100, sellValueB:100, buyCountI:10, sellCountI:6 });
  assert.ok(Math.abs(out.strongNetB + 40) < 1e-9);
});

test('v8.15.1 SMT corrections: legal-funded real buying and small power are not "strong"', () => {
  // real bought 100 but only 40 came from real sellers (60 from legal): only 40 is matched
  const a = F.smartMoneySMT({ buyValueB:100, sellValueB:40, buyCountI:50, sellCountI:20 }); // bpc 2, spc 2 → power 1
  assert.equal(a.strongNetB, 0);
  const b = F.smartMoneySMT({ buyValueB:100, sellValueB:40, buyCountI:25, sellCountI:20 }); // bpc 4, spc 2
  assert.ok(Math.abs(b.strongInB - 40 * 0.5) < 1e-9);
  assert.ok(Math.abs(b.rawNetB - 50) < 1e-9);
  // power 1.2 is inside the dead zone
  assert.equal(F.smartMoneySMT({ buyValueB:120, sellValueB:120, buyCountI:100, sellCountI:120 }).strongNetB, 0);
  // opting out of both corrections reproduces the raw channel formula
  assert.ok(Math.abs(F.smartMoneySMT({ buyValueB:100, sellValueB:40, buyCountI:25, sellCountI:20 }, { minPower:1, legalAdjust:false }).strongInB - 50) < 1e-9);
});

test('v8.15 computeClientMetrics bigMoneyB = matched × (1 − 1/buyPower)', () => {
  // خگستر-like: per-capita 1.36 vs 0.66 B rial, real buy = real sell
  const nb = 1889, B = 1.36 * nb, ns = Math.round(B / 0.66);
  const x = F.computeClientMetrics({
    client: { buy_I_Value:B*1e9, sell_I_Value:B*1e9, buy_I_Count:nb, sell_I_Count:ns },
    priceRial: 1000
  });
  const spc = B / ns;
  assert.ok(Math.abs(x.bigMoneyB - nb * (1.36 - spc)) < 1e-6);
  assert.equal(x.bigSellB, 0);
  assert.ok(x.bigBuyB <= x.individualBuyB);
});
