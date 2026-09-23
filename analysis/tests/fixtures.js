'use strict';
// Synthetic TSETMC-shaped API responses for tests (no network).

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function day(i) {
  const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000);
  return Number(d.toISOString().slice(0, 10).replace(/-/g, ''));
}

// drift: daily % drift; splitAt: bar index where a 1:1 capital increase halves the price.
function dailyJson({ n = 260, start = 10000, drift = 0.3, vol = 1.5, seed = 1, splitAt = -1 } = {}) {
  const r = rng(seed);
  const rows = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    let yesterday = prev;
    if (i === splitAt) yesterday = Math.round(prev / 2);
    const close = Math.max(100, Math.round(yesterday * (1 + (drift + (r() - 0.5) * 2 * vol) / 100)));
    const high = Math.round(Math.max(close, yesterday) * (1 + r() * 0.01));
    const low = Math.round(Math.min(close, yesterday) * (1 - r() * 0.01));
    const volume = Math.round(1e6 * (0.5 + r()));
    rows.push({ priceChange: close - yesterday, priceMin: low, priceMax: high, priceYesterday: yesterday, priceFirst: yesterday, last: false, id: 0, insCode: '0', dEven: day(i), hEven: 0, pClosing: close, iClose: false, yClose: false, pDrCotVal: close, zTotTran: 500, qTotTran5J: volume, qTotCap: volume * close });
    prev = close;
  }
  // one non-trading day that must be dropped
  rows.push({ dEven: day(n + 5), pClosing: prev, qTotTran5J: 0, qTotCap: 0, priceYesterday: prev });
  return { closingPriceDaily: rows.reverse() }; // TSETMC returns newest first
}

function clientJson({ n = 260, inflow = 1, seed = 2 } = {}) {
  const r = rng(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const base = 5e11 * (0.5 + r());
    const buyI = base * (1 + 0.2 * inflow), sellI = base * (1 - 0.2 * inflow);
    rows.push({ recDate: day(i), insCode: '1', buy_I_Volume: 1e6, sell_I_Volume: 1e6, buy_N_Volume: 1e5, sell_N_Volume: 1e5, buy_CountI: inflow > 0 ? 300 : 900, sell_CountI: inflow > 0 ? 900 : 300, buy_CountN: 2, sell_CountN: 2, buy_I_Value: buyI, sell_I_Value: sellI, buy_N_Value: sellI * 0.1, sell_N_Value: buyI * 0.1 });
  }
  return { clientType: rows.reverse() };
}

function infoJson({ symbol, eps = 1000, sectorPE = 8, shares = 1e9 } = {}) {
  return { instrumentInfo: { lVal18AFC: symbol, lVal30: `شرکت ${symbol}`, insCode: '1', zTitad: shares, baseVol: 1e5, flow: 1, eps: { epsValue: eps, estimatedEPS: String(eps), sectorPE, psr: 1 }, sector: { cSecVal: '27 ', lSecVal: 'فلزات اساسی' } } };
}

function indexJson({ n = 260, drift = 0.1 } = {}) {
  const rows = [];
  let v = 2e6;
  for (let i = 0; i < n; i++) { v *= 1 + drift / 100; rows.push({ insCode: '32097828799138957', dEven: day(i), xNivInuClMresIbs: v, xNivInuPbMresIbs: v * 0.99, xNivInuPhMresIbs: v * 1.01 }); }
  return { indexB2: rows };
}

module.exports = { day, dailyJson, clientJson, infoJson, indexJson };
