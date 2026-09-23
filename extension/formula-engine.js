(function attachFormulaEngine(root, factory) {
  const api = factory();
  root.RadarFormulaEngine = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createFormulaEngine() {
  'use strict';

  // Money is stored internally in BILLION RIALS. UI converts to toman only when rendering.
  const RIAL_PER_BILLION_RIAL = 1e9;
  const BILLION_RIAL_PER_BILLION_TOMAN = 10;

  // Large money is estimated from short client-type snapshots, not from a smooth
  // fraction of the whole trading day. Internal money unit is billion rials.
  // 1.0 B rial = 100 M toman, used as the minimum per-real-code threshold.
  // 4.0 B rial = 400 M toman is kept only as a calibration/reference ceiling;
  // values above it are still classified as large.
  const LARGE_ORDER_MIN_B = 1.0;
  const LARGE_ORDER_FULL_B = 4.0;
  const LARGE_FLOW_SNAPSHOT_MS = 2000;
  const TAPE_BASE_FLOOR_B = 1.0; // 100M toman
  const TAPE_HISTORY_QUANTILE = 0.95;
  const TAPE_LIQUIDITY_FRACTION = 0.0005; // 0.05% of observed daily turnover
  const TAPE_MIN_REAL_SHARE = 0.10;
  const TAPE_MIN_CONFIDENCE = 0.50;
  const POWER_RATIO_CAP = 20;

  function n(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function smoothstep01(t) {
    const x = clamp(n(t), 0, 1);
    return x * x * (3 - 2 * x);
  }
  function get(obj, keys) {
    for (const k of keys) {
      if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return undefined;
  }

  function normalizeClient(client) {
    const c = client || {};
    return {
      insCode: String(get(c, ['insCode','InsCode','inscode','instrumentID','id','code']) || '').trim(),
      buyVolI: n(get(c, ['buyVolI','buy_I_Volume','Buy_I_Volume','buyIVolume','n_buy_volume'])),
      sellVolI: n(get(c, ['sellVolI','sell_I_Volume','Sell_I_Volume','sellIVolume','n_sell_volume'])),
      buyCountI: n(get(c, ['buyCountI','buy_CountI','Buy_CountI','buyICount','buy_I_Count','Buy_I_Count','n_buy_count'])),
      buyCountN: n(get(c, ['buyCountN','buy_CountN','Buy_CountN','buyNCount','buy_N_Count','Buy_N_Count','l_buy_count'])),
      sellCountI: n(get(c, ['sellCountI','sell_CountI','Sell_CountI','sellICount','sell_I_Count','Sell_I_Count','n_sell_count'])),
      sellCountN: n(get(c, ['sellCountN','sell_CountN','Sell_CountN','sellNCount','sell_N_Count','Sell_N_Count','l_sell_count'])),
      buyVolN: n(get(c, ['buyVolN','buy_N_Volume','Buy_N_Volume','l_buy_volume'])),
      sellVolN: n(get(c, ['sellVolN','sell_N_Volume','Sell_N_Volume','l_sell_volume'])),
      buyValueI: n(get(c, ['buyValueI','buyValI','buy_I_Value','Buy_I_Value','n_buy_value'])),
      sellValueI: n(get(c, ['sellValueI','sellValI','sell_I_Value','Sell_I_Value','n_sell_value'])),
      buyValueN: n(get(c, ['buyValueN','buy_N_Value','Buy_N_Value','l_buy_value'])),
      sellValueN: n(get(c, ['sellValueN','sell_N_Value','Sell_N_Value','l_sell_value']))
    };
  }

  function resolveFlowPriceRial(market) {
    const m = market || {};
    const value = n(get(m, ['tradeValueRial','qTotCap','totalValue','tradeValue','value','tval','qtc']));
    const volume = n(get(m, ['volume','qTotTran5J','totalVolume','tvol','qtj']));
    const vwap = value > 0 && volume > 0 ? value / volume : 0;
    if (vwap > 0) return vwap;
    return n(get(m, ['closePrice','pClosing','pcl','pc','lastPrice','pDrCotVal','pdv','pl','yesterday','priceYesterday','py']));
  }

  function ratio(numerator, denominator) {
    const a = n(numerator), b = n(denominator);
    if (a <= 0 && b <= 0) return 1;
    if (a > 0 && b <= 0) return POWER_RATIO_CAP;
    if (a <= 0 && b > 0) return 0;
    return clamp(a / b, 0, POWER_RATIO_CAP);
  }

  function largeOrderShare(avgOrderB, _sidePower) {
    // Snapshot classifier: once per-capita flow crosses the configured floor,
    // the whole side-flow is considered large. We deliberately do NOT subtract
    // the floor and do NOT use the former 50M→600M smoothstep.
    const avg = n(avgOrderB);
    return avg >= LARGE_ORDER_MIN_B ? 1 : 0;
  }

  // "حقیقی قوی" (Smart Money Tracker definition), with two corrections:
  //   raw:       strongIn = BuyCountI × (buyPerCapita − sellPerCapita) = RealBuy × (1 − 1/buyerPower)
  //   1) legal correction: only the real↔real matched part min(RealBuy, RealSell) can be a
  //      transfer from weak to strong real hands; real money bought from/sold to legal
  //      entities is already shown in «پول حقیقی» and is not counted again.
  //   2) dead zone: per-capita differences below SMT_MIN_POWER (1.3×) are noise → 0.
  //   strongIn  = min(B,S) × (1 − sellPerCapita/buyPerCapita)   when buyPower  ≥ SMT_MIN_POWER
  //   strongOut = min(B,S) × (1 − buyPerCapita/sellPerCapita)   when sellPower ≥ SMT_MIN_POWER
  // With B = S and minPower = 1 this is exactly the channel formula.
  const SMT_MIN_POWER = 1.3;
  function smartMoneySMT({ buyValueB, sellValueB, buyCountI, sellCountI } = {}, options = {}) {
    const B = n(buyValueB), S = n(sellValueB), nb = n(buyCountI), ns = n(sellCountI);
    if (!(B > 0 && S > 0 && nb > 0 && ns > 0)) {
      return { buyPerCapitaB: 0, sellPerCapitaB: 0, matchedB: 0, strongInB: 0, strongOutB: 0, strongNetB: 0, rawNetB: 0, valid: false };
    }
    const minPower = Math.max(1, Number.isFinite(Number(options.minPower)) ? Number(options.minPower) : SMT_MIN_POWER);
    const legalAdjust = options.legalAdjust !== false;
    const bpc = B / nb, spc = S / ns;
    const matchedB = Math.min(B, S);
    const rawNetB = bpc > spc ? nb * (bpc - spc) : -(ns * (spc - bpc));
    let strongInB = 0, strongOutB = 0;
    if (bpc / spc >= minPower) strongInB = (legalAdjust ? matchedB : B) * (1 - spc / bpc);
    else if (spc / bpc >= minPower) strongOutB = (legalAdjust ? matchedB : S) * (1 - bpc / spc);
    return { buyPerCapitaB: bpc, sellPerCapitaB: spc, matchedB, strongInB, strongOutB, strongNetB: strongInB - strongOutB, rawNetB, valid: true };
  }

  function computeClientMetrics({ client, market, priceRial, preferDirectValues = true } = {}) {
    const c = normalizeClient(client);
    const px = n(priceRial) > 0 ? n(priceRial) : resolveFlowPriceRial(market);

    const fallbackBuyValue = c.buyVolI > 0 && px > 0 ? c.buyVolI * px : 0;
    const fallbackSellValue = c.sellVolI > 0 && px > 0 ? c.sellVolI * px : 0;
    const buyDirect = Boolean(preferDirectValues && c.buyValueI > 0);
    const sellDirect = Boolean(preferDirectValues && c.sellValueI > 0);
    const buyValueRial = buyDirect ? c.buyValueI : fallbackBuyValue;
    const sellValueRial = sellDirect ? c.sellValueI : fallbackSellValue;

    const individualBuyB = buyValueRial / RIAL_PER_BILLION_RIAL;
    const individualSellB = sellValueRial / RIAL_PER_BILLION_RIAL;
    const realMoneyB = individualBuyB - individualSellB;

    const buyAvgOrderB = c.buyCountI > 0 ? individualBuyB / c.buyCountI : 0;
    const sellAvgOrderB = c.sellCountI > 0 ? individualSellB / c.sellCountI : 0;
    const buyPower = ratio(buyAvgOrderB, sellAvgOrderB);
    const sellPower = ratio(sellAvgOrderB, buyAvgOrderB);

    const smt = smartMoneySMT({ buyValueB: individualBuyB, sellValueB: individualSellB, buyCountI: c.buyCountI, sellCountI: c.sellCountI });
    const bigBuyB = smt.strongInB;
    const bigSellB = smt.strongOutB;
    const largeBuyShare = individualBuyB > 0 ? bigBuyB / individualBuyB : 0;
    const largeSellShare = individualSellB > 0 ? bigSellB / individualSellB : 0;
    const bigMoneyB = bigBuyB - bigSellB;

    return {
      flowPriceRial: px,
      buyValueRial, sellValueRial,
      buyValueSource: buyDirect ? 'official-value' : (fallbackBuyValue > 0 ? 'volume-x-price' : 'unavailable'),
      sellValueSource: sellDirect ? 'official-value' : (fallbackSellValue > 0 ? 'volume-x-price' : 'unavailable'),
      ...c,
      individualBuyB, individualSellB, realMoneyB,
      buyAvgOrderB, sellAvgOrderB, buyPower, sellPower,
      largeBuyShare, largeSellShare,
      bigBuyB, bigSellB, bigMoneyB
    };
  }

  function intervalFlowDelta(prevRow, currRow, options = {}) {
    if (!prevRow || !currRow) return null;
    const thresholdB = Math.max(0.01, n(options.thresholdB) || LARGE_ORDER_MIN_B);

    const pb = n(prevRow.buyVolI), ps = n(prevRow.sellVolI);
    const cb = n(currRow.buyVolI), cs = n(currRow.sellVolI);
    const dBuyVolI = cb - pb, dSellVolI = cs - ps;
    const dBuyCountI = n(currRow.buyCountI) - n(prevRow.buyCountI);
    const dSellCountI = n(currRow.sellCountI) - n(prevRow.sellCountI);

    // Cumulative counters occasionally reset/reconcile. Rebase instead of
    // fabricating a negative/positive large-money interval.
    if (dBuyVolI < 0 || dSellVolI < 0 || dBuyCountI < 0 || dSellCountI < 0) return null;

    let dBuyB = null, dSellB = null;
    const prevBuyValueB = n(prevRow.individualBuyB);
    const currBuyValueB = n(currRow.individualBuyB);
    const prevSellValueB = n(prevRow.individualSellB);
    const currSellValueB = n(currRow.individualSellB);
    const directBuy = prevRow.buyValueSource === 'official-value' && currRow.buyValueSource === 'official-value';
    const directSell = prevRow.sellValueSource === 'official-value' && currRow.sellValueSource === 'official-value';

    if (directBuy) dBuyB = currBuyValueB - prevBuyValueB;
    if (directSell) dSellB = currSellValueB - prevSellValueB;

    // If direct cumulative buy/sell values are unavailable, value interval
    // volume with VWAP of the SAME market interval (not today's final/current
    // price). valueB is market turnover in billion rials.
    const dMarketVol = n(currRow.volume) - n(prevRow.volume);
    const dMarketValueB = n(currRow.valueB) - n(prevRow.valueB);
    let intervalPriceRial = 0;
    if (dMarketVol > 0 && dMarketValueB >= 0) {
      intervalPriceRial = dMarketValueB * RIAL_PER_BILLION_RIAL / dMarketVol;
    }
    if (!(intervalPriceRial > 0)) {
      intervalPriceRial = n(currRow.flowPriceRial) || n(currRow.closePrice) || n(currRow.lastPrice);
    }
    if (!(intervalPriceRial > 0)) return null;

    if (dBuyB === null) dBuyB = dBuyVolI * intervalPriceRial / RIAL_PER_BILLION_RIAL;
    if (dSellB === null) dSellB = dSellVolI * intervalPriceRial / RIAL_PER_BILLION_RIAL;
    if (dBuyB < -1e-9 || dSellB < -1e-9) return null;
    dBuyB = Math.max(0, dBuyB);
    dSellB = Math.max(0, dSellB);
    const dRealB = dBuyB - dSellB;

    // Primary rule: average money of NEW real codes in the snapshot interval.
    // If no new code appears, the identity of the continuing traders is not
    // observable from aggregate ClientType. In that case we conservatively use
    // the current cumulative per-code average, and require the interval itself
    // to be at least the threshold before classifying the whole interval side.
    const buyIntervalAvgB = dBuyCountI > 0
      ? dBuyB / dBuyCountI
      : n(currRow.buyAvgOrderB);
    const sellIntervalAvgB = dSellCountI > 0
      ? dSellB / dSellCountI
      : n(currRow.sellAvgOrderB);

    const buyLarge = dBuyB >= thresholdB && buyIntervalAvgB >= thresholdB;
    const sellLarge = dSellB >= thresholdB && sellIntervalAvgB >= thresholdB;
    const dBigBuyB = buyLarge ? dBuyB : 0;
    const dBigSellB = sellLarge ? dSellB : 0;
    const dBigB = dBigBuyB - dBigSellB;

    return {
      dBuyVolI, dSellVolI, dBuyCountI, dSellCountI,
      dBuyB, dSellB, dRealB,
      buyIntervalAvgB, sellIntervalAvgB,
      buyLarge, sellLarge,
      dBigBuyB, dBigSellB, dBigB,
      intervalPriceRial,
      thresholdB
    };
  }


  function percentile(values, q) {
    const arr = (Array.isArray(values) ? values : []).map(n).filter(v => Number.isFinite(v) && v > 0).sort((a,b)=>a-b);
    if (!arr.length) return 0;
    const pos = clamp(n(q), 0, 1) * (arr.length - 1);
    const lo = Math.floor(pos), hi = Math.min(arr.length - 1, lo + 1), t = pos - lo;
    return arr[lo] + (arr[hi] - arr[lo]) * t;
  }

  function adaptiveTapeThreshold(historyGrossB, currentDayValueB, options = {}) {
    const floorB = Math.max(0.01, n(options.floorB) || TAPE_BASE_FLOOR_B);
    const q = Number.isFinite(Number(options.quantile)) ? Number(options.quantile) : TAPE_HISTORY_QUANTILE;
    const liqFraction = Number.isFinite(Number(options.liquidityFraction)) ? Number(options.liquidityFraction) : TAPE_LIQUIDITY_FRACTION;
    const history = (Array.isArray(historyGrossB) ? historyGrossB : []).map(n).filter(v => v > 0);
    const qB = history.length >= 20 ? percentile(history, q) : 0;
    const liqB = Math.max(0, n(currentDayValueB)) * Math.max(0, liqFraction);
    return Math.max(floorB, qB, liqB);
  }

  function estimateTapeClientFlow(prevRow, currRow, options = {}) {
    if (!prevRow || !currRow) return null;
    const client = intervalFlowDelta(prevRow, currRow, { thresholdB: options.floorB || TAPE_BASE_FLOOR_B });
    if (!client) return null;

    const dMarketValueB = n(currRow.valueB) - n(prevRow.valueB);
    const dMarketVol = n(currRow.volume) - n(prevRow.volume);
    const dTradeCount = n(currRow.tradeCount) - n(prevRow.tradeCount);
    if (dMarketValueB < -1e-9 || dMarketVol < -1e-9 || dTradeCount < 0) return null;
    if (!(dMarketValueB > 0)) {
      return { ...client, dMarketValueB:0, dMarketVol:Math.max(0,dMarketVol), dTradeCount:Math.max(0,dTradeCount), tapeSide:0, thresholdB:adaptiveTapeThreshold(options.historyGrossB, currRow.valueB, options), confidence:0, realShare:0, attributedRealB:0, dBigBuyB:0, dBigSellB:0, dBigB:0, qualifies:false };
    }

    const thresholdB = adaptiveTapeThreshold(options.historyGrossB, currRow.valueB, options);
    const prevLast = n(prevRow.lastPrice) || n(prevRow.closePrice);
    const currLast = n(currRow.lastPrice) || n(currRow.closePrice);
    let tapeSide = 0;
    if (currLast > 0 && prevLast > 0) {
      if (currLast > prevLast) tapeSide = 1;
      else if (currLast < prevLast) tapeSide = -1;
    }
    if (!tapeSide) {
      if (client.dRealB > 0) tapeSide = 1;
      else if (client.dRealB < 0) tapeSide = -1;
      else tapeSide = Math.sign(n(options.previousSide));
    }

    const sideRealB = tapeSide > 0 ? client.dBuyB : tapeSide < 0 ? client.dSellB : 0;
    const realShare = dMarketValueB > 0 ? clamp(sideRealB / dMarketValueB, 0, 1) : 0;
    const attributedRealB = Math.min(dMarketValueB, Math.max(0, sideRealB));
    const avgTradeB = dTradeCount > 0 ? dMarketValueB / dTradeCount : dMarketValueB;
    const fragmentAdjustedB = dMarketValueB / Math.sqrt(Math.max(1, dTradeCount));
    const tapeStrength = clamp(dMarketValueB / Math.max(thresholdB, 1e-9), 0, 1);
    const concentration = clamp(fragmentAdjustedB / Math.max(TAPE_BASE_FLOOR_B * 0.35, 1e-9), 0, 1);
    const priceImpactPct = prevLast > 0 && currLast > 0 ? Math.abs((currLast - prevLast) / prevLast) * 100 : 0;
    const impact = clamp(priceImpactPct / 0.15, 0, 1);
    const previousSide = Math.sign(n(options.previousSide));
    const sameSideRun = Math.max(0, Math.floor(n(options.sameSideRun)));
    const persistence = previousSide && previousSide === tapeSide ? clamp((sameSideRun + 1) / 3, 0, 1) : 0.25;
    const confidence = clamp(0.30*tapeStrength + 0.25*realShare + 0.15*impact + 0.15*concentration + 0.15*persistence, 0, 1);

    const minRealShare = Math.max(0, Number.isFinite(Number(options.minRealShare)) ? Number(options.minRealShare) : TAPE_MIN_REAL_SHARE);
    const minConfidence = clamp(Number.isFinite(Number(options.minConfidence)) ? Number(options.minConfidence) : TAPE_MIN_CONFIDENCE, 0, 1);
    const qualifies = Boolean(
      tapeSide !== 0 &&
      dMarketValueB >= thresholdB &&
      realShare >= minRealShare &&
      attributedRealB >= TAPE_BASE_FLOOR_B &&
      fragmentAdjustedB >= TAPE_BASE_FLOOR_B * 0.35 &&
      confidence >= minConfidence
    );
    const dBigBuyB = qualifies && tapeSide > 0 ? attributedRealB : 0;
    const dBigSellB = qualifies && tapeSide < 0 ? attributedRealB : 0;
    const dBigB = dBigBuyB - dBigSellB;

    return {
      ...client, dMarketValueB, dMarketVol:Math.max(0,dMarketVol), dTradeCount:Math.max(0,dTradeCount),
      thresholdB, tapeSide, realShare, attributedRealB, avgTradeB, fragmentAdjustedB,
      priceImpactPct, tapeStrength, concentration, persistence, confidence, qualifies,
      dBigBuyB, dBigSellB, dBigB
    };
  }

  function estimateCumulativeLargePrior(metrics, options = {}) {
    const m = metrics || {};
    const floorB = Math.max(0.01, n(options.floorB) || TAPE_BASE_FLOOR_B);
    const fullB = Math.max(floorB * 1.5, n(options.fullB) || LARGE_ORDER_FULL_B);

    function sideShare(avgOrderB, sidePower) {
      const avg = Math.max(0, n(avgOrderB));
      if (avg < floorB) return 0;
      // Prior only: conservative continuous share for the part of the session
      // that happened before the 2-second observer started. It is NOT used for
      // subsequently observed intervals. 100M starts near 20%, 400M+ approaches
      // 90%, with a small power tilt.
      const t = clamp((avg - floorB) / Math.max(1e-9, fullB - floorB), 0, 1);
      const base = 0.20 + 0.70 * smoothstep01(t);
      const p = clamp(n(sidePower) || 1, 0.25, 4);
      const tilt = clamp(1 + 0.08 * Math.log(p), 0.88, 1.12);
      return clamp(base * tilt, 0, 0.92);
    }

    const buyShare = sideShare(m.buyAvgOrderB, m.buyPower);
    const sellShare = sideShare(m.sellAvgOrderB, m.sellPower);
    const bigBuyB = Math.max(0, n(m.individualBuyB)) * buyShare;
    const bigSellB = Math.max(0, n(m.individualSellB)) * sellShare;
    return {
      bigBuyB, bigSellB, bigMoneyB: bigBuyB - bigSellB,
      buyShare, sellShare,
      confidence: 0.35,
      method: 'cumulative-clienttype-prior'
    };
  }

  function movingAverageAt(values, index, period) {
    const p = Math.max(1, Math.floor(n(period)));
    if (!Array.isArray(values) || index < p - 1 || index >= values.length) return null;
    let s = 0;
    for (let i = index - p + 1; i <= index; i++) {
      const v = Number(values[i]);
      if (!Number.isFinite(v)) return null;
      s += v;
    }
    return s / p;
  }

  function netWindow(days, period, key = 'hotB') {
    const p = Math.max(1, Math.floor(n(period)));
    if (!Array.isArray(days)) return null;
    const seen = new Set();
    const vals = [];
    for (const d of days) {
      const id = String(d?.key ?? '');
      if (!id || seen.has(id)) continue;
      const v = Number(d?.[key]);
      if (!Number.isFinite(v)) continue;
      seen.add(id); vals.push(v);
      if (vals.length === p) break;
    }
    return vals.length === p ? vals.reduce((a,b)=>a+b,0) : null;
  }

  function billionRialToBillionToman(v) { return n(v) / BILLION_RIAL_PER_BILLION_TOMAN; }

  return {
    RIAL_PER_BILLION_RIAL,
    BILLION_RIAL_PER_BILLION_TOMAN,
    LARGE_ORDER_MIN_B,
    LARGE_ORDER_FULL_B,
    LARGE_FLOW_SNAPSHOT_MS,
    TAPE_BASE_FLOOR_B, TAPE_HISTORY_QUANTILE, TAPE_LIQUIDITY_FRACTION, TAPE_MIN_REAL_SHARE, TAPE_MIN_CONFIDENCE,
    normalizeClient,
    resolveFlowPriceRial,
    ratio,
    largeOrderShare,
    SMT_MIN_POWER, smartMoneySMT,
    computeClientMetrics,
    intervalFlowDelta,
    percentile, adaptiveTapeThreshold, estimateTapeClientFlow, estimateCumulativeLargePrior,
    movingAverageAt,
    netWindow,
    billionRialToBillionToman
  };
});
