(function attachSmartScan(root, factory) {
  const api = factory(root);
  root.RadarSmartScan = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSmartScan(root) {
  'use strict';

  // Composite daily scan, modelled on how screeners are built elsewhere
  // (relative volume + normalized money flow + relative strength/trend).
  // Every flow is expressed as a share of the symbol's own traded value and
  // compared with the symbol's own history, so small and large caps are comparable.
  // Money unit: billion rial (as in formula-engine).

  const MIN_VALUE_B = 10;          // 1B toman traded today, below this the symbol is ignored
  const WEIGHTS = { flow: 0.50, activity: 0.20, trend: 0.30 };

  function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function lin(v, lo, hi) { return hi === lo ? 0 : clamp((n(v) - lo) / (hi - lo), 0, 1); }
  function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
  function std(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
  }

  // Fraction of the regular 09:00–12:30 session already elapsed (Tehran). Used so
  // that 10:00 turnover is compared with the part of an average day it represents.
  function sessionFraction(hms) {
    const x = n(hms);
    if (!x) return 1;
    const sec = Math.floor(x / 10000) * 3600 + Math.floor((x % 10000) / 100) * 60 + (x % 100);
    return clamp((sec - 9 * 3600) / (3.5 * 3600), 0.15, 1);
  }

  function engine() { return root.RadarFormulaEngine; }

  // Big money for one historical day from a ClientType record (same formula as today).
  function dayFlow(client, priceRial) {
    const F = engine();
    if (!F) return null;
    const m = F.computeClientMetrics({ client, priceRial: n(priceRial), preferDirectValues: true });
    if (!(m.individualBuyB > 0 || m.individualSellB > 0)) return null;
    return { realB: m.realMoneyB, bigB: m.bigMoneyB, bigBuyB: m.bigBuyB, bigSellB: m.bigSellB };
  }

  // days: ascending by key, excluding today; each {key, close, valueB, realB?, bigB?}
  function symbolFeatures(row, days, opts = {}) {
    const r = row || {};
    const hist = (Array.isArray(days) ? days : []).filter(d => d && n(d.close) > 0).sort((a, b) => Number(a.key) - Number(b.key));
    const valueB = n(r.valueB);
    const bigB = n(r.bigMoneyB), realB = n(r.realMoneyB);
    const price = n(r.lastPrice) || n(r.closePrice);
    const frac = n(opts.sessionFraction) || 1;

    const bigPct = valueB > 0 ? bigB / valueB * 100 : 0;
    const realPct = valueB > 0 ? realB / valueB * 100 : 0;

    const last20 = hist.slice(-20);
    const avgValue20 = mean(last20.map(d => n(d.valueB)).filter(v => v > 0));
    const valueRatio = avgValue20 > 0 ? valueB / (avgValue20 * frac) : null;

    // Money flow history (days where ClientType was loaded)
    const flowDays = hist.filter(d => Number.isFinite(d.bigB) && n(d.valueB) > 0);
    const f4 = flowDays.slice(-4);
    const big5B = bigB + f4.reduce((s, d) => s + n(d.bigB), 0);
    const val5B = valueB + f4.reduce((s, d) => s + n(d.valueB), 0);
    const big5Pct = f4.length >= 2 && val5B > 0 ? big5B / val5B * 100 : null;
    const real5B = realB + f4.reduce((s, d) => s + n(d.realB), 0);
    const histBigPct = flowDays.slice(-20).map(d => n(d.bigB) / n(d.valueB) * 100);
    const sd = std(histBigPct);
    const bigZ = histBigPct.length >= 5 && sd > 0 ? (bigPct - mean(histBigPct)) / sd : null;
    let streak = 0;
    const sign = Math.sign(bigB);
    if (sign) {
      streak = 1;
      for (let i = flowDays.length - 1; i >= 0; i--) {
        if (Math.sign(n(flowDays[i].bigB)) === sign) streak++; else break;
      }
    }

    // Trend / relative strength inputs
    const closes = hist.map(d => n(d.close));
    const withToday = price > 0 ? closes.concat(price) : closes;
    const ret = k => withToday.length > k ? (withToday[withToday.length - 1] / withToday[withToday.length - 1 - k] - 1) * 100 : null;
    const ma = k => withToday.length >= k ? mean(withToday.slice(-k)) : null;
    const ret20 = ret(20), ret60 = ret(60);
    const ma20 = ma(20), ma50 = ma(50);
    const high20 = closes.length >= 10 ? Math.max(...closes.slice(-20)) : null;

    return {
      row: r, valueB, bigB, realB, bigPct, realPct, bigBuyB: n(r.bigBuyB), bigSellB: n(r.bigSellB),
      pulseB: n(r.bigMoneyPulseB), buyPower: n(r.buyPower), sellPower: n(r.sellPower),
      buyAvgOrderB: n(r.buyAvgOrderB), sellAvgOrderB: n(r.sellAvgOrderB),
      avgValue20, valueRatio, big5B, big5Pct, real5B, bigZ, streak, flowDays: flowDays.length,
      price, ret20, ret60, ma20, ma50, high20, histDays: hist.length
    };
  }

  function percentileRanks(values) {
    const idx = values.map((v, i) => [v, i]).filter(x => x[0] !== null && Number.isFinite(x[0])).sort((a, b) => a[0] - b[0]);
    const out = new Array(values.length).fill(null);
    idx.forEach(([, i], k) => { out[i] = idx.length > 1 ? k / (idx.length - 1) : 0.5; });
    return out;
  }

  // dir = +1 ranks inflow candidates, −1 ranks outflow (exit) warnings.
  function scoreFeature(f, rs, dir) {
    const d = dir;
    const flow = 0.35 * lin(d * f.bigPct, 0, 20)
      + 0.25 * (f.big5Pct === null ? lin(d * f.bigPct, 0, 20) * 0.5 : lin(d * f.big5Pct, 0, 10))
      + 0.20 * (f.bigZ === null ? 0 : lin(d * f.bigZ, 0, 3))
      + 0.20 * lin(d * f.realPct, 0, 20);
    const activity = f.valueRatio === null ? 0.3 : lin(f.valueRatio, 1, 4);
    let trend = 0.5;
    if (rs !== null || f.ma20 !== null) {
      const rsPart = rs === null ? 0.5 : (d > 0 ? rs : 1 - rs);
      const above = f.price > 0 && f.ma20 ? (f.price >= f.ma20 ? 1 : 0) * 0.5 + (f.ma50 ? (f.price >= f.ma50 ? 0.5 : 0) : 0.25) : 0.5;
      const aboveDir = d > 0 ? above : 1 - above;
      const nearHigh = f.high20 ? lin(f.price / f.high20, 0.9, 1) : 0.5;
      trend = 0.5 * rsPart + 0.25 * aboveDir + 0.25 * (d > 0 ? nearHigh : 1 - nearHigh);
    }
    const total = 100 * (WEIGHTS.flow * flow + WEIGHTS.activity * activity + WEIGHTS.trend * trend);
    return { total: Math.round(total * 10) / 10, flow, activity, trend };
  }

  function reasons(f, dir) {
    const out = [];
    const d = dir;
    if (d * f.bigPct >= 5) out.push(`درشت ${Math.round(Math.abs(f.bigPct))}٪ ارزش امروز`);
    if (f.big5Pct !== null && d * f.big5Pct >= 3) out.push(`درشت ۵روزه ${Math.round(Math.abs(f.big5Pct))}٪`);
    if (f.streak >= 3 && Math.sign(f.bigB) === d) out.push(`${f.streak} روز پیاپی ${d > 0 ? 'ورود' : 'خروج'} درشت`);
    if (f.bigZ !== null && d * f.bigZ >= 2) out.push('درشت غیرعادی نسبت به ۲۰ روز');
    if (f.valueRatio !== null && f.valueRatio >= 2) out.push(`ارزش ${f.valueRatio.toFixed(1)}× میانگین`);
    if (d * f.pulseB > 0) out.push(`پالس ${d > 0 ? 'خرید' : 'فروش'} درشت ۶۰ث`);
    return out;
  }

  function scan(rows, histMap, opts = {}) {
    const frac = sessionFraction(opts.hms);
    const list = (rows || []).filter(r => r && r.hasClient && n(r.valueB) >= (opts.minValueB ?? MIN_VALUE_B));
    const feats = list.map(r => symbolFeatures(r, (histMap && histMap[opts.keyOf ? opts.keyOf(r) : r.insCode]) || [], { sessionFraction: frac }));
    const mom = feats.map(f => (f.ret20 === null && f.ret60 === null) ? null : 0.5 * n(f.ret20) + 0.5 * (f.ret60 === null ? n(f.ret20) : f.ret60));
    const rsRanks = percentileRanks(mom);
    const items = feats.map((f, i) => {
      const inS = scoreFeature(f, rsRanks[i], 1), outS = scoreFeature(f, rsRanks[i], -1);
      return { ...f, rs: rsRanks[i], inScore: inS, outScore: outS, inReasons: reasons(f, 1), outReasons: reasons(f, -1) };
    });
    const limit = opts.limit || 10;
    // A candidate needs actual inflow today (big or real), an exit warning needs actual outflow.
    const inflow = items.filter(x => x.bigB > 0 || (x.big5Pct !== null && x.big5Pct > 0 && x.realB > 0))
      .sort((a, b) => b.inScore.total - a.inScore.total).slice(0, limit);
    const outflow = items.filter(x => x.bigB < 0 || (x.big5Pct !== null && x.big5Pct < 0 && x.realB < 0))
      .sort((a, b) => b.outScore.total - a.outScore.total).slice(0, limit);

    const valueSum = items.reduce((s, x) => s + x.valueB, 0);
    const withMa = items.filter(x => x.ma20);
    const regime = {
      symbols: items.length,
      advancers: items.filter(x => n(x.row.lastPercent) > 0).length,
      decliners: items.filter(x => n(x.row.lastPercent) < 0).length,
      aboveMa20Pct: withMa.length ? withMa.filter(x => x.price >= x.ma20).length / withMa.length * 100 : null,
      realPct: valueSum > 0 ? items.reduce((s, x) => s + x.realB, 0) / valueSum * 100 : 0,
      bigPct: valueSum > 0 ? items.reduce((s, x) => s + x.bigB, 0) / valueSum * 100 : 0,
      bigInCount: items.filter(x => x.bigB > 0).length,
      bigOutCount: items.filter(x => x.bigB < 0).length,
      withHistory: items.filter(x => x.histDays >= 20).length,
      withFlowHistory: items.filter(x => x.flowDays >= 4).length
    };
    const breadth = regime.symbols ? (regime.advancers - regime.decliners) / regime.symbols : 0;
    const maPart = regime.aboveMa20Pct === null ? 0 : (regime.aboveMa20Pct - 50) / 50;
    const regimeScore = 0.4 * breadth + 0.3 * maPart + 0.3 * clamp(regime.realPct / 10, -1, 1);
    regime.score = regimeScore;
    regime.label = regimeScore >= 0.25 ? 'مثبت' : regimeScore <= -0.25 ? 'منفی' : 'خنثی';
    return { inflow, outflow, regime, items, sessionFraction: frac };
  }

  return { MIN_VALUE_B, WEIGHTS, sessionFraction, dayFlow, symbolFeatures, percentileRanks, scoreFeature, reasons, scan };
});
