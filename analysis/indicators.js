'use strict';

// Technical indicators over plain number arrays (oldest → newest).
// Every function returns an array aligned with its input; positions without
// enough history are NaN so callers can tell "not enough data" from zero.

const nan = n => new Array(n).fill(NaN);
const last = a => a[a.length - 1];

function sma(values, period) {
  const out = nan(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = nan(values.length);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder smoothing (RMA), seeded with the simple mean of the first `period` values.
function rma(values, period, start = 0) {
  const out = nan(values.length);
  if (values.length - start < period) return out;
  let prev = 0;
  for (let i = start; i < start + period; i++) prev += values[i];
  prev /= period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const n = closes.length;
  const gains = new Array(n).fill(0), losses = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    gains[i] = Math.max(d, 0);
    losses[i] = Math.max(-d, 0);
  }
  const g = rma(gains, period, 1), l = rma(losses, period, 1);
  return g.map((gv, i) => {
    if (!Number.isFinite(gv)) return NaN;
    if (l[i] === 0) return gv === 0 ? 50 : 100;
    return 100 - 100 / (1 + gv / l[i]);
  });
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => f[i] - s[i]);
  const firstValid = line.findIndex(Number.isFinite);
  const sig = nan(closes.length);
  if (firstValid >= 0) {
    const tail = ema(line.slice(firstValid), signal);
    tail.forEach((v, j) => { sig[firstValid + j] = v; });
  }
  return { line, signal: sig, hist: line.map((v, i) => v - sig[i]) };
}

function trueRange(high, low, close) {
  return high.map((h, i) => i === 0 ? h - low[i] : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1])));
}

function atr(high, low, close, period = 14) {
  return rma(trueRange(high, low, close), period);
}

function adx(high, low, close, period = 14) {
  const n = close.length;
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(high, low, close);
  const trS = rma(tr, period, 1), pS = rma(plusDM, period, 1), mS = rma(minusDM, period, 1);
  const plusDI = trS.map((t, i) => (t > 0 ? 100 * pS[i] / t : NaN));
  const minusDI = trS.map((t, i) => (t > 0 ? 100 * mS[i] / t : NaN));
  const dx = plusDI.map((p, i) => {
    const s = p + minusDI[i];
    return s > 0 ? 100 * Math.abs(p - minusDI[i]) / s : (Number.isFinite(s) ? 0 : NaN);
  });
  const firstValid = dx.findIndex(Number.isFinite);
  const adxLine = nan(n);
  if (firstValid >= 0) rma(dx.slice(firstValid), period).forEach((v, j) => { adxLine[firstValid + j] = v; });
  return { adx: adxLine, plusDI, minusDI };
}

function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = nan(closes.length), lower = nan(closes.length), pctB = nan(closes.length);
  for (let i = period - 1; i < closes.length; i++) {
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    pctB[i] = upper[i] > lower[i] ? (closes[i] - lower[i]) / (upper[i] - lower[i]) : 0.5;
  }
  return { mid, upper, lower, pctB };
}

function rollingExtreme(values, period, fn) {
  return values.map((_, i) => (i < period - 1 ? NaN : fn(...values.slice(i - period + 1, i + 1))));
}

// Ichimoku (9/26/52). Span A/B are reported for the *current* bar, i.e. the cloud
// that was projected 26 bars ago and now sits under/over price.
function ichimoku(high, low, close) {
  const mid = p => {
    const lo = rollingExtreme(low, p, Math.min);
    return rollingExtreme(high, p, Math.max).map((h, i) => (h + lo[i]) / 2);
  };
  const tenkan = mid(9), kijun = mid(26), senkouB0 = mid(52);
  const senkouA0 = tenkan.map((t, i) => (t + kijun[i]) / 2);
  const shift = a => a.map((_, i) => (i >= 26 ? a[i - 26] : NaN));
  return { tenkan, kijun, spanA: shift(senkouA0), spanB: shift(senkouB0), futureSpanA: senkouA0, futureSpanB: senkouB0 };
}

function obv(closes, volumes) {
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    out[i] = out[i - 1] + (closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0);
  }
  return out;
}

// Least-squares slope of the last `period` points, as % of their mean per bar.
function slopePct(values, period) {
  const ys = values.slice(-period).filter(Number.isFinite);
  const n = ys.length;
  if (n < 3) return NaN;
  const xm = (n - 1) / 2, ym = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => { num += (x - xm) * (y - ym); den += (x - xm) ** 2; });
  return ym !== 0 ? (num / den) / Math.abs(ym) * 100 : NaN;
}

// Fractal swing points: a bar whose high (low) is the extreme of `k` bars on each side.
function swings(high, low, k = 3) {
  const highs = [], lows = [];
  for (let i = k; i < high.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (high[j] >= high[i]) isHigh = false;
      if (low[j] <= low[i]) isLow = false;
    }
    if (isHigh) highs.push({ i, price: high[i] });
    if (isLow) lows.push({ i, price: low[i] });
  }
  return { highs, lows };
}

// Merges swing prices within `tolPct` of each other into levels, weighted by touches.
function levels(points, tolPct = 1.5) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const out = [];
  for (const p of sorted) {
    const lv = out[out.length - 1];
    if (lv && Math.abs(p.price - lv.price) / lv.price * 100 <= tolPct) {
      lv.price = (lv.price * lv.touches + p.price) / (lv.touches + 1);
      lv.touches++;
      lv.lastIndex = Math.max(lv.lastIndex, p.i);
    } else out.push({ price: p.price, touches: 1, lastIndex: p.i });
  }
  return out;
}

function classicPivots(h, l, c) {
  const p = (h + l + c) / 3;
  return { p, r1: 2 * p - l, s1: 2 * p - h, r2: p + (h - l), s2: p - (h - l) };
}

// Regular divergence between price and an oscillator over the last two swing points.
function divergence(high, low, osc, lookback = 60, k = 3) {
  const start = Math.max(0, high.length - lookback);
  const sw = swings(high.slice(start), low.slice(start), k);
  const shift = s => s.map(p => ({ ...p, i: p.i + start }));
  const hs = shift(sw.highs).slice(-2), ls = shift(sw.lows).slice(-2);
  if (hs.length === 2 && hs[1].price > hs[0].price && osc[hs[1].i] < osc[hs[0].i]) return { type: 'bearish', at: hs[1].i };
  if (ls.length === 2 && ls[1].price < ls[0].price && osc[ls[1].i] > osc[ls[0].i]) return { type: 'bullish', at: ls[1].i };
  return null;
}

module.exports = {
  last, sma, ema, rma, rsi, macd, trueRange, atr, adx, bollinger, rollingExtreme,
  ichimoku, obv, slopePct, swings, levels, classicPivots, divergence
};
