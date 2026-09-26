#!/usr/bin/env node
'use strict';

// Technical + fundamental report for Tehran Stock Exchange symbols, built from the
// gzipped JSON the extension's data-export page produces.
//
//   node analysis/tse-report.js <tse-export.json.gz> [--out <dir>] [--top 25] [--min-value 3]
//
// Writes report.md (Persian), metrics.csv and metrics.json into --out (default: ./report).
// Units: prices in rial (as TSETMC shows them); money in billion toman (rial / 1e10).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ind = require('./indicators');
const { smartMoneySMT } = require('../smart-money/smt-formula');

const B_TOMAN = 1e10;
const MIN_BARS = 60;
const FUND_SECTOR = '68'; // صندوق سرمایه‌گذاری قابل معامله: no earnings, excluded from stock ranking

const isNum = Number.isFinite;
const round = (v, d = 1) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const pct = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? (a / b - 1) * 100 : NaN);
const mean = a => { const v = a.filter(isNum); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN; };
const sum = a => a.filter(isNum).reduce((x, y) => x + y, 0);
const median = a => { const v = a.filter(isNum).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// TSETMC returns Arabic ye/kaf; show Persian letters in the report.
const faText = v => String(v || '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim();

function loadExport(file) {
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}

function toObjects(block) {
  if (!block || !Array.isArray(block.rows)) return [];
  return block.rows.map(r => Object.fromEntries(block.columns.map((c, i) => [c, r[i]])));
}

// Back-adjusts prices for capital increases / dividends: whenever today's reference
// price differs from yesterday's close, every earlier bar is scaled by that ratio.
function adjustPrices(bars) {
  const out = bars.map(b => ({ ...b }));
  let factor = 1;
  const events = [];
  for (let i = out.length - 1; i >= 0; i--) {
    if (factor !== 1) {
      for (const k of ['open', 'high', 'low', 'close', 'last']) if (isNum(out[i][k])) out[i][k] *= factor;
      if (isNum(out[i].vol)) out[i].vol /= factor;
    }
    if (i > 0) {
      const ref = bars[i].yesterday, prevClose = bars[i - 1].close;
      if (ref > 0 && prevClose > 0 && Math.abs(ref / prevClose - 1) > 0.005) {
        factor *= ref / prevClose;
        events.push({ d: bars[i].d, ratio: ref / prevClose });
      }
    }
  }
  return { bars: out, events };
}

function fillOhlc(b) {
  const close = b.close;
  return { ...b, open: b.open > 0 ? b.open : close, high: b.high > 0 ? b.high : close, low: b.low > 0 ? b.low : close };
}

function barsFrom(item) {
  return toObjects(item.daily).filter(b => b.close > 0).map(fillOhlc).sort((a, b) => a.d - b.d);
}

function technicals(bars) {
  const close = bars.map(b => b.close), high = bars.map(b => b.high), low = bars.map(b => b.low), vol = bars.map(b => b.vol || 0);
  const n = close.length, i = n - 1, c = close[i];
  const s20 = ind.sma(close, 20), s50 = ind.sma(close, 50), s200 = ind.sma(close, 200);
  const r = ind.rsi(close, 14);
  const m = ind.macd(close);
  const a = ind.atr(high, low, close, 14);
  const dx = ind.adx(high, low, close, 14);
  const bb = ind.bollinger(close, 20, 2);
  const ich = ind.ichimoku(high, low, close);
  const ob = ind.obv(close, vol);
  const win = Math.min(n, 240);
  const hi52 = Math.max(...high.slice(-win)), lo52 = Math.min(...low.slice(-win));

  const cloudTop = Math.max(ich.spanA[i], ich.spanB[i]), cloudBottom = Math.min(ich.spanA[i], ich.spanB[i]);
  const cloud = !isNum(cloudTop) ? null : c > cloudTop ? 'above' : c < cloudBottom ? 'below' : 'inside';

  const lookback = Math.min(n, 250);
  const off = n - lookback;
  const sw = ind.swings(high.slice(-lookback), low.slice(-lookback), 3);
  const shifted = s => s.map(p => ({ ...p, i: p.i + off }));
  const lv = ind.levels([...shifted(sw.highs), ...shifted(sw.lows)], 1.5);
  const supports = lv.filter(l => l.price < c * 0.99).sort((x, y) => y.price - x.price);
  const resistances = lv.filter(l => l.price > c * 1.01).sort((x, y) => x.price - y.price);
  const piv = ind.classicPivots(high[i], low[i], c);

  const macdCrossBars = (() => {
    for (let k = i; k > Math.max(0, i - 10); k--) {
      const now = m.line[k] - m.signal[k], prev = m.line[k - 1] - m.signal[k - 1];
      if (isNum(now) && isNum(prev) && Math.sign(now) !== Math.sign(prev)) return { barsAgo: i - k, dir: now > 0 ? 'up' : 'down' };
    }
    return null;
  })();

  const vol5 = mean(vol.slice(-5)), vol20 = mean(vol.slice(-20));
  // Queue days (buy or sell queue at the daily price limit): the whole session trades at
  // one price, so high == low. Indicators and ATR understate risk on such symbols and a
  // stop cannot be executed inside a sell queue.
  const lockedDays20 = bars.slice(-20).filter(b => b.high === b.low).length;
  const sellQueueDays5 = bars.slice(-5).filter((b, k, arr) => b.high === b.low && b.close < (k ? arr[k - 1].close : close[n - 6])).length;
  return {
    lockedDays20, sellQueueDays5, rsiPrev3: r[i - 3], rsiMin10: Math.min(...r.slice(-10).filter(isNum)),
    close: c,
    dayHigh: high[i], dayLow: low[i],
    lastDate: bars[i].d,
    chg1d: pct(c, close[i - 1]),
    ret5: pct(c, close[i - 5]), ret20: pct(c, close[i - 20]), ret60: pct(c, close[i - 60]), ret120: pct(c, close[i - 120]),
    sma20: s20[i], sma50: s50[i], sma200: s200[i],
    vsSma20: pct(c, s20[i]), vsSma50: pct(c, s50[i]), vsSma200: pct(c, s200[i]),
    rsi: r[i], rsiPrev5: r[i - 5],
    macd: m.line[i], macdSignal: m.signal[i], macdHist: m.hist[i], macdHistRising: m.hist[i] > m.hist[i - 3], macdCross: macdCrossBars,
    adx: dx.adx[i], plusDI: dx.plusDI[i], minusDI: dx.minusDI[i],
    atr: a[i], atrPct: a[i] / c * 100,
    bbPctB: bb.pctB[i], bbWidthPct: (bb.upper[i] - bb.lower[i]) / bb.mid[i] * 100,
    tenkan: ich.tenkan[i], kijun: ich.kijun[i], cloud, cloudTop, cloudBottom,
    futureCloudBullish: ich.futureSpanA[i] > ich.futureSpanB[i],
    hi52, lo52, fromHigh52: pct(c, hi52), fromLow52: pct(c, lo52),
    volRatio: vol20 > 0 ? vol5 / vol20 : NaN,
    obvSlope20: ind.slopePct(ob, 20), priceSlope20: ind.slopePct(close, 20),
    divergence: ind.divergence(high, low, r, 60, 3),
    support1: supports[0] || null, support2: supports[1] || null,
    resistance1: resistances[0] || null, resistance2: resistances[1] || null,
    pivots: piv,
    series: { close, rsi: r }
  };
}

function moneyFlow(item, bars) {
  const rows = toObjects(item.client).sort((a, b) => a.d - b.d);
  if (!rows.length) return null;
  const byDay = rows.slice(-60);
  const netReal = r => (r.buyIVal - r.sellIVal) / B_TOMAN;
  const netLegal = r => (r.buyNVal - r.sellNVal) / B_TOMAN;
  const power = r => (r.buyICount > 0 && r.sellICount > 0 && r.sellIVal > 0 ? (r.buyIVal / r.buyICount) / (r.sellIVal / r.sellICount) : NaN);
  const smt = r => smartMoneySMT({ buyValueI: r.buyIVal, sellValueI: r.sellIVal, buyCountI: r.buyICount, sellCountI: r.sellICount }).strongNet / B_TOMAN;
  const lastN = k => byDay.slice(-k);
  const totalValue = k => sum(lastN(k).map(r => (r.buyIVal + r.buyNVal) / B_TOMAN));
  const value20 = mean(bars.slice(-20).map(b => b.value / B_TOMAN));
  return {
    lastDate: byDay[byDay.length - 1].d,
    netReal1: netReal(byDay[byDay.length - 1]),
    netReal5: sum(lastN(5).map(netReal)),
    netReal20: sum(lastN(20).map(netReal)),
    netLegal20: sum(lastN(20).map(netLegal)),
    power1: power(byDay[byDay.length - 1]),
    power5: mean(lastN(5).map(power)),
    smt5: sum(lastN(5).map(smt)),
    smt20: sum(lastN(20).map(smt)),
    inflowDays10: lastN(10).filter(r => netReal(r) > 0).length,
    realShare20: (() => { const t = totalValue(20); return t > 0 ? sum(lastN(20).map(r => r.buyIVal / B_TOMAN)) / t * 100 : NaN; })(),
    // Net real 20d as % of 20d traded value: comparable across large and small caps.
    netReal20PctOfValue: value20 > 0 ? sum(lastN(20).map(netReal)) / (value20 * 20) * 100 : NaN
  };
}

function fundamentals(item, close) {
  const info = item.info || {};
  const eps = info.epsForecast > 0 ? info.epsForecast : info.epsTtm;
  const pe = eps > 0 ? close / eps : NaN;
  return {
    sectorName: info.sectorName || '',
    sectorCode: info.sectorCode || '',
    eps: isNum(eps) ? eps : NaN,
    epsSource: info.epsForecast > 0 ? 'forecast' : info.epsTtm > 0 ? 'ttm' : null,
    pe,
    sectorPE: info.sectorPE > 0 ? info.sectorPE : NaN,
    peVsSector: info.sectorPE > 0 && pe > 0 ? (pe / info.sectorPE - 1) * 100 : NaN,
    marketCapHemat: info.shares > 0 ? close * info.shares / 1e13 : NaN,
    floatPct: info.floatPct,
    psr: info.psr,
    codalMonthly: (item.codal && item.codal.monthly || []).slice(0, 3),
    codalStatements: (item.codal && item.codal.statements || []).slice(0, 2),
    codalTables: (item.codal && item.codal.monthlyTables || []).length
  };
}

function scoreTrend(t) {
  let s = 0;
  if (t.close > t.sma20) s += 10;
  if (t.close > t.sma50) s += 15;
  if (isNum(t.sma200) ? t.close > t.sma200 : t.close > t.sma50) s += 15;
  if (t.sma20 > t.sma50) s += 10;
  if (isNum(t.sma200) ? t.sma50 > t.sma200 : t.sma20 > t.sma50) s += 10;
  if (t.cloud === 'above') s += 15; else if (t.cloud === 'inside') s += 6;
  if (t.tenkan > t.kijun) s += 5;
  if (t.adx > 20 && t.plusDI > t.minusDI) s += 20; else if (t.plusDI > t.minusDI) s += 8;
  return s;
}

function scoreMomentum(t, rs60) {
  let s = 0;
  const r = t.rsi;
  if (r >= 50 && r < 70) s += 35; else if (r >= 70 && r < 80) s += 20; else if (r >= 40 && r < 50) s += 20; else if (r < 30) s += 12; else if (r >= 80) s += 5; else s += 8;
  if (t.macd > t.macdSignal) s += 25;
  if (t.macdHistRising) s += 10;
  if (t.ret20 > 0) s += 10;
  if (isNum(rs60)) { if (rs60 > 0) s += 20; else if (rs60 > -10) s += 8; } else if (t.ret60 > 0) s += 12;
  return s;
}

function scoreMoney(f, t) {
  if (!f) return NaN;
  let s = 0;
  if (f.netReal5 > 0) s += 25;
  if (f.netReal20 > 0) s += 15;
  if (f.netReal20PctOfValue > 5) s += 10;
  if (isNum(f.power5)) s += clamp((f.power5 - 0.8) / 0.8, 0, 1) * 20;
  if (f.smt5 > 0) s += 15;
  s += clamp(f.inflowDays10 / 10, 0, 1) * 5;
  if (t.volRatio > 1.2 && t.ret5 > 0) s += 10;
  return s;
}

function scoreValue(fd, t) {
  // No positive EPS means losses or no forecast: score it low rather than dropping the
  // weight, otherwise loss-makers are ranked on momentum alone and float to the top.
  if (!(fd.pe > 0)) return 10;
  let s = 0;
  const d = fd.peVsSector;
  if (isNum(d)) s += d < -30 ? 50 : d < -10 ? 38 : d < 10 ? 25 : d < 30 ? 12 : 4;
  else s += 20;
  s += fd.pe < 5 ? 30 : fd.pe < 8 ? 22 : fd.pe < 12 ? 12 : fd.pe < 20 ? 5 : 0;
  if (t.fromHigh52 < -25) s += 20; else if (t.fromHigh52 < -10) s += 10;
  return Math.min(100, s);
}

function composite(parts) {
  const weights = { trend: 0.3, momentum: 0.2, money: 0.25, value: 0.25 };
  let w = 0, s = 0;
  for (const [k, wk] of Object.entries(weights)) if (isNum(parts[k])) { s += parts[k] * wk; w += wk; }
  return w ? s / w : NaN;
}

function tradePlan(t) {
  const c = t.close, a = t.atr;
  const sup = t.support1 && t.support1.price > c - 3 * a ? t.support1.price : NaN;
  // Stop half an ATR under the nearest support, but never wider than 2.5 ATR or 12%.
  let stop = isNum(sup) ? sup - 0.5 * a : c - 2 * a;
  stop = Math.max(stop, c - 2.5 * a, c * 0.88);
  const entryLow = isNum(sup) ? Math.max(sup, c - a) : c - a;
  // Targets: the next resistance levels; with none overhead (all-time high) use 3 and 5 ATR.
  const t1 = t.resistance1 ? t.resistance1.price : c + 3 * a;
  const t2 = t.resistance2 ? t.resistance2.price : t.resistance1 ? Math.max(t1 + 2 * a, t.hi52 > t1 ? t.hi52 : 0) : c + 5 * a;
  return { entryLow, entryHigh: c, stop, target1: t1, target2: t2, riskPct: (c - stop) / c * 100, rr: (t1 - c) / (c - stop), athTargets: !t.resistance1 };
}

function classify(score, t, f, liquidityB, fd, plan) {
  const flags = [];
  if (liquidityB < 3) flags.push('نقدشوندگی پایین');
  if (t.divergence && t.divergence.type === 'bearish') flags.push('واگرایی منفی RSI');
  if (t.rsi >= 78) flags.push('اشباع خرید');
  if (t.vsSma20 > 15) flags.push('فاصله زیاد از MA20');
  if (f && f.netReal20 < 0 && f.netReal20PctOfValue < -5) flags.push('خروج مستمر پول حقیقی');
  if (t.adx < 15) flags.push('بدون روند (ADX پایین)');
  if (!(fd.pe > 0)) flags.push('بدون EPS مثبت');
  const queueDriven = t.lockedDays20 >= 6;
  if (queueDriven) flags.push(`سهم صفی: ${t.lockedDays20} روز از ۲۰ روز در صف (ریسک نقدشوندگی و اجرای حد ضرر)`);
  const parabolic = t.ret60 > 100 || t.vsSma50 > 30;
  if (parabolic) flags.push(`رشد عمودی (${Math.round(t.ret60)}٪ در ۶۰ روز، ${Math.round(t.vsSma50)}٪ بالای MA50)`);
  if (fd.pe > 30) flags.push(`P/E بالا (${Math.round(fd.pe)})`);
  const overextended = t.rsi >= 75 || t.vsSma20 > 12;
  const nearResistance = plan.rr < 1.2;
  // Entry-risk filters: conditions that make a high score unsafe to buy now.
  const risks = [];
  if (f && f.netLegal20 < 0 && f.netReal20 > 0 && -f.netLegal20 >= 0.5 * f.netReal20) risks.push(`عرضه حقوقی به حقیقی (${Math.round(f.netLegal20)} میلیارد تومان در ۲۰ روز)`);
  if (t.vsSma200 > 50) risks.push(`${Math.round(t.vsSma200)}٪ بالای MA200`);
  else if (t.fromLow52 > 150) risks.push(`${Math.round(t.fromLow52)}٪ بالای کف ۵۲ هفته`);
  if (f && f.power5 < 0.8) risks.push(`سرانه خرید ضعیف (${f.power5.toFixed(2)})`);
  if (t.divergence && t.divergence.type === 'bearish') risks.push('واگرایی منفی');
  if (plan.riskPct > 7) risks.push(`حد ضرر دور (${plan.riskPct.toFixed(1)}٪)`);
  if (liquidityB < 10) risks.push('نقدشوندگی کمتر از ۱۰ میلیارد تومان');
  if (isNum(fd.floatPct) && fd.floatPct < 15) risks.push(`شناوری کم (${fd.floatPct}٪)`);
  if (t.sellQueueDays5 > 0) risks.push('صف فروش در ۵ روز اخیر');
  for (const r of risks) if (!flags.includes(r)) flags.push(r);
  let signal;
  if (score >= 70 && !(fd.pe > 0 && fd.pe <= 30)) signal = 'زیر نظر';
  else if (score >= 70 && (queueDriven || parabolic)) signal = 'پرریسک؛ صفی/رشد عمودی';
  else if (score >= 70 && !overextended && nearResistance) signal = 'قوی؛ نزدیک مقاومت، منتظر شکست یا پولبک';
  else if (score >= 70 && !overextended && risks.length) signal = 'قوی ولی پرریسک؛ فعلاً ورود نه';
  else if (score >= 70 && !overextended) signal = 'ورود پله‌ای';
  else if (score >= 70) signal = 'قوی ولی پرشده؛ منتظر پولبک';
  else if (score >= 55) signal = 'زیر نظر';
  else if (score < 40) signal = 'اجتناب';
  else signal = 'خنثی';
  if (t.divergence && t.divergence.type === 'bullish' && score >= 45 && signal !== 'ورود پله‌ای') flags.push('واگرایی مثبت RSI');
  return { signal, flags, risks };
}

function analyzeIndex(block) {
  const rows = toObjects(block).filter(r => r.close > 0).map(r => ({ ...r, high: r.high > 0 ? r.high : r.close, low: r.low > 0 ? r.low : r.close, open: r.close, vol: 0 }));
  if (rows.length < MIN_BARS) return null;
  return technicals(rows);
}

function analyzeSymbol(item0, indexT, opts) {
  const item = { ...item0, symbol: faText(item0.symbol), name: faText(item0.name), info: item0.info && { ...item0.info, sectorName: faText(item0.info.sectorName) } };
  if (item.info && item.info.sectorCode === FUND_SECTOR) return { symbol: item.symbol, skipped: 'صندوق', fund: true };
  const raw = barsFrom(item);
  if (raw.length < MIN_BARS) return { symbol: item.symbol, skipped: `تاریخچه کافی نیست (${raw.length} روز)` };
  const { bars, events } = adjustPrices(raw);
  const t = technicals(bars);
  const f = moneyFlow(item, bars);
  const fd = fundamentals(item, t.close);
  const rs60 = indexT && isNum(indexT.ret60) ? t.ret60 - indexT.ret60 : NaN;
  const rs20 = indexT && isNum(indexT.ret20) ? t.ret20 - indexT.ret20 : NaN;
  const liquidityB = mean(raw.slice(-20).map(b => b.value / B_TOMAN));
  const stale = indexT && t.lastDate < indexT.lastDate;
  const parts = { trend: scoreTrend(t), momentum: scoreMomentum(t, rs60), money: scoreMoney(f, t), value: scoreValue(fd, t) };
  let score = composite(parts);
  if (liquidityB < opts.minValue) score -= 10;
  if (stale) score -= 5;
  const plan = tradePlan(t);
  const cls = classify(score, t, f, liquidityB, fd, plan);
  if (stale) cls.flags.push(`آخرین معامله ${t.lastDate} (متوقف یا کم‌معامله)`);
  return {
    symbol: item.symbol, name: item.name, insCode: item.insCode,
    score, parts, ...cls, rs20, rs60, liquidityB, adjustments: events.length,
    tech: t, flow: f, fund: fd, plan
  };
}

function breadth(results) {
  const ok = results.filter(r => r.tech);
  const share = fn => (ok.length ? ok.filter(fn).length / ok.length * 100 : NaN);
  return {
    count: ok.length,
    aboveSma50: share(r => r.tech.close > r.tech.sma50),
    aboveSma200: share(r => isNum(r.tech.sma200) && r.tech.close > r.tech.sma200),
    medianRsi: median(ok.map(r => r.tech.rsi)),
    positive5d: share(r => r.tech.ret5 > 0),
    netReal5: sum(ok.map(r => r.flow && r.flow.netReal5)),
    netReal20: sum(ok.map(r => r.flow && r.flow.netReal20)),
    sectors: (() => {
      const m = new Map();
      for (const r of ok) {
        const k = r.fund.sectorName || 'نامشخص';
        const s = m.get(k) || { name: k, n: 0, score: 0, netReal20: 0 };
        s.n++; s.score += r.score; s.netReal20 += (r.flow && r.flow.netReal20) || 0;
        m.set(k, s);
      }
      return [...m.values()].map(s => ({ ...s, score: s.score / s.n })).sort((a, b) => b.netReal20 - a.netReal20);
    })()
  };
}

// ---------- rendering ----------

const fa = (v, d = 0) => (isNum(v) ? Number(v.toFixed(d)).toLocaleString('fa-IR') : '—');
const faPct = (v, d = 1) => (isNum(v) ? `${v > 0 ? '+' : ''}${fa(v, d)}٪` : '—');
const faDate = d => (d ? String(d).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : '—');
const cloudFa = c => ({ above: 'بالای ابر', inside: 'داخل ابر', below: 'زیر ابر' }[c] || '—');

function indexSection(name, t) {
  if (!t) return `- ${name}: داده کافی نیست.\n`;
  return [
    `**${name}** — ${fa(t.close)} (${faDate(t.lastDate)})`,
    `- بازده: ۵ روز ${faPct(t.ret5)} · ۲۰ روز ${faPct(t.ret20)} · ۶۰ روز ${faPct(t.ret60)} · فاصله از سقف ۵۲ هفته ${faPct(t.fromHigh52)}`,
    `- MA20 ${fa(t.sma20)} (${faPct(t.vsSma20)}) · MA50 ${fa(t.sma50)} (${faPct(t.vsSma50)}) · MA200 ${fa(t.sma200)} (${faPct(t.vsSma200)})`,
    `- RSI(14) ${fa(t.rsi, 1)} · MACD ${t.macd > t.macdSignal ? 'بالای' : 'زیر'} سیگنال${t.macdCross ? ` (کراس ${t.macdCross.dir === 'up' ? 'صعودی' : 'نزولی'} ${fa(t.macdCross.barsAgo)} روز پیش)` : ''} · ADX ${fa(t.adx, 1)} (+DI ${fa(t.plusDI, 1)} / −DI ${fa(t.minusDI, 1)})`,
    `- ایچیموکو: ${cloudFa(t.cloud)}، تنکان ${t.tenkan > t.kijun ? 'بالای' : 'زیر'} کیجون (${fa(t.kijun)})، ابر آینده ${t.futureCloudBullish ? 'صعودی' : 'نزولی'}`,
    `- حمایت‌ها: ${[t.support1, t.support2].filter(Boolean).map(l => `${fa(l.price)} (${fa(l.touches)} برخورد)`).join('، ') || '—'} · مقاومت‌ها: ${[t.resistance1, t.resistance2].filter(Boolean).map(l => `${fa(l.price)} (${fa(l.touches)} برخورد)`).join('، ') || '—'}`,
    t.divergence ? `- ⚠️ واگرایی ${t.divergence.type === 'bearish' ? 'منفی' : 'مثبت'} RSI` : ''
  ].filter(Boolean).join('\n') + '\n';
}

function symbolCard(r) {
  const t = r.tech, f = r.flow, fd = r.fund, p = r.plan;
  const lines = [
    `### ${r.symbol} — ${r.name || ''}`,
    `**امتیاز ${fa(r.score)} از ۱۰۰ · ${r.signal}**  (روند ${fa(r.parts.trend)} · مومنتوم ${fa(r.parts.momentum)} · پول ${fa(r.parts.money)} · ارزش ${fa(r.parts.value)})${r.flags.length ? `\n⚠️ ${r.flags.join(' · ')}` : ''}`,
    '',
    `**تکنیکال** — آخرین قیمت ${fa(t.close)} ریال (${faDate(t.lastDate)}، ${faPct(t.chg1d)})`,
    `- بازده ۵/۲۰/۶۰ روز: ${faPct(t.ret5)} / ${faPct(t.ret20)} / ${faPct(t.ret60)} · قدرت نسبی به شاخص (۶۰ روز): ${faPct(r.rs60)}`,
    `- MA20 ${fa(t.sma20)} (${faPct(t.vsSma20)}) · MA50 ${fa(t.sma50)} (${faPct(t.vsSma50)}) · MA200 ${fa(t.sma200)} (${faPct(t.vsSma200)})`,
    `- RSI ${fa(t.rsi, 1)} · MACD ${t.macd > t.macdSignal ? 'بالای' : 'زیر'} سیگنال، هیستوگرام ${t.macdHistRising ? 'افزایشی' : 'کاهشی'}${t.macdCross ? ` · کراس ${t.macdCross.dir === 'up' ? 'صعودی' : 'نزولی'} ${fa(t.macdCross.barsAgo)} روز پیش` : ''}`,
    `- ADX ${fa(t.adx, 1)} (+DI ${fa(t.plusDI, 1)} / −DI ${fa(t.minusDI, 1)}) · ATR ${fa(t.atrPct, 1)}٪ · بولینگر %B ${fa(t.bbPctB, 2)}`,
    `- ایچیموکو: ${cloudFa(t.cloud)}، تنکان ${t.tenkan > t.kijun ? '>' : '<'} کیجون، ابر آینده ${t.futureCloudBullish ? 'صعودی' : 'نزولی'}`,
    `- حجم ۵ به ۲۰ روز: ${fa(t.volRatio, 2)}× · OBV ${t.obvSlope20 > 0 ? 'صعودی' : 'نزولی'} · سقف/کف ۵۲ هفته: ${fa(t.hi52)} / ${fa(t.lo52)} (${faPct(t.fromHigh52)})`,
    `- حمایت: ${[t.support1, t.support2].filter(Boolean).map(l => fa(l.price)).join('، ') || '—'} · مقاومت: ${[t.resistance1, t.resistance2].filter(Boolean).map(l => fa(l.price)).join('، ') || '—'} · پیوت: ${fa(t.pivots.p)} (S1 ${fa(t.pivots.s1)} / R1 ${fa(t.pivots.r1)})`
  ];
  if (f) lines.push(
    '',
    `**تابلوخوانی** (میلیارد تومان)`,
    `- خالص حقیقی: امروز ${fa(f.netReal1, 1)} · ۵ روز ${fa(f.netReal5, 1)} · ۲۰ روز ${fa(f.netReal20, 1)} (${faPct(f.netReal20PctOfValue)} از ارزش معاملات) · حقوقی ۲۰ روز ${fa(f.netLegal20, 1)}`,
    `- قدرت خریدار (سرانه خرید/فروش): امروز ${fa(f.power1, 2)} · میانگین ۵ روز ${fa(f.power5, 2)} · حقیقی قوی (SMT) ۵ روز ${fa(f.smt5, 1)} · روزهای ورود پول در ۱۰ روز: ${fa(f.inflowDays10)}`,
    `- میانگین ارزش معاملات ۲۰ روز: ${fa(r.liquidityB, 1)}`
  );
  lines.push(
    '',
    `**بنیادی** — ${fd.sectorName || 'گروه نامشخص'}`,
    `- EPS ${fa(fd.eps)} (${fd.epsSource === 'forecast' ? 'پیش‌بینی' : fd.epsSource === 'ttm' ? 'TTM' : '—'}) · P/E ${fa(fd.pe, 1)} · P/E گروه ${fa(fd.sectorPE, 1)} (${faPct(fd.peVsSector)}) · ارزش بازار ${fa(fd.marketCapHemat, 1)} همت${isNum(fd.floatPct) ? ` · شناوری ${fa(fd.floatPct)}٪` : ''}`
  );
  if (fd.codalMonthly.length) lines.push(`- کدال (ماهانه): ${fd.codalMonthly.map(l => `${l.title.replace(/\s+/g, ' ').slice(0, 70)} [${l.publishDate}]`).join(' | ')}`);
  lines.push(
    '',
    `**برنامه معامله** — محدوده ورود ${fa(p.entryLow)} تا ${fa(p.entryHigh)} · حد ضرر ${fa(p.stop)} (${faPct(-p.riskPct)}) · هدف اول ${fa(p.target1)} (${faPct(pct(p.target1, t.close))}) · هدف دوم ${fa(p.target2)} · ریسک به ریوارد ${fa(p.rr, 2)}${p.athTargets ? ' (در سقف: مقاومتی در ۲۵۰ روز اخیر نیست؛ هدف‌ها ۳ و ۵ ATR)' : ''}`,
    ''
  );
  return lines.join('\n');
}

// Oversold (low RSI) screen: a low RSI alone is not a buy; separate likely rebounds
// from stocks that are still falling.
function oversold(ok, maxRsi = 35) {
  return ok.filter(r => r.tech.rsi < maxRsi).map(r => {
    const t = r.tech, f = r.flow, fd = r.fund;
    const good = [], bad = [];
    if (isNum(t.sma200) && t.close > t.sma200) good.push('بالای MA200'); else bad.push('زیر MA200');
    if (fd.pe > 0 && (!isNum(fd.sectorPE) || fd.pe <= fd.sectorPE * 1.1) && fd.pe <= 20) good.push(`P/E ${fa(fd.pe, 1)}`); else bad.push(fd.pe > 0 ? `P/E ${fa(fd.pe, 1)}` : 'بدون EPS');
    if (f && f.netReal5 > 0) good.push('ورود حقیقی ۵ر'); else bad.push('خروج حقیقی ۵ر');
    if (f && f.power1 > 1.2) good.push(`قدرت خریدار ${fa(f.power1, 1)}`);
    if (t.rsi > t.rsiPrev3 && t.rsiMin10 < t.rsi) good.push('RSI برگشته'); else bad.push('RSI هنوز نزولی');
    if (t.divergence && t.divergence.type === 'bullish') good.push('واگرایی مثبت');
    if (t.sellQueueDays5 > 0) bad.push(`${fa(t.sellQueueDays5)} روز صف فروش`);
    if (r.liquidityB < 3) bad.push('نقدشوندگی پایین');
    const q = good.length - bad.length;
    const label = q >= 3 && !(t.sellQueueDays5 > 1) && fd.pe > 0 ? 'کاندید برگشت' : q <= -2 || t.sellQueueDays5 > 1 ? 'در حال ریزش؛ صبر' : 'منتظر تأیید';
    return { r, q, good, bad, label };
  }).sort((a, b) => b.q - a.q || a.r.tech.rsi - b.r.tech.rsi);
}

function renderReport(data, results, indexT, eqT, opts) {
  const ok = results.filter(r => r.tech).sort((a, b) => b.score - a.score);
  const skipped = results.filter(r => r.skipped);
  const br = breadth(ok);
  const top = ok.slice(0, opts.top);
  const md = [];
  md.push(`# گزارش فنی و بنیادی بورس تهران`);
  md.push(`داده: ${data.exportedAt} · ${fa(ok.length)} نماد تحلیل‌شده${skipped.length ? ` · ${fa(skipped.length)} نماد رد شد` : ''} · قیمت‌ها به ریال و تعدیل‌شده برای افزایش سرمایه/سود نقدی · پول به میلیارد تومان\n`);

  md.push(`## ۱. وضعیت بازار`);
  md.push(indexSection('شاخص کل', indexT));
  md.push(indexSection('شاخص هم‌وزن', eqT));
  md.push(`**پهنای بازار (نمادهای این فایل)**`);
  md.push(`- بالای MA50: ${fa(br.aboveSma50)}٪ · بالای MA200: ${fa(br.aboveSma200)}٪ · میانه RSI: ${fa(br.medianRsi, 1)} · مثبت در ۵ روز: ${fa(br.positive5d)}٪`);
  md.push(`- خالص پول حقیقی: ۵ روز ${fa(br.netReal5)} · ۲۰ روز ${fa(br.netReal20)} میلیارد تومان\n`);
  if (br.sectors.length > 1) {
    md.push(`**گروه‌ها (بر اساس ورود پول حقیقی ۲۰ روز)**\n`);
    md.push(`| گروه | تعداد | میانگین امتیاز | خالص حقیقی ۲۰ روز |`);
    md.push(`|---|---|---|---|`);
    for (const s of br.sectors.slice(0, 12)) md.push(`| ${s.name} | ${fa(s.n)} | ${fa(s.score)} | ${fa(s.netReal20, 1)} |`);
    md.push('');
  }

  md.push(`## ۲. رتبه‌بندی`);
  md.push(`| # | نماد | قیمت | امتیاز | سیگنال | RSI | روند | خالص حقیقی ۵ر | P/E | P/E گروه | ورود | حد ضرر | هدف ۱ | R/R |`);
  md.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  top.forEach((r, i) => md.push(`| ${fa(i + 1)} | ${r.symbol} | ${fa(r.tech.close)} | ${fa(r.score)} | ${r.signal} | ${fa(r.tech.rsi)} | ${fa(r.parts.trend)} | ${fa(r.flow && r.flow.netReal5, 1)} | ${fa(r.fund.pe, 1)} | ${fa(r.fund.sectorPE, 1)} | ${fa(r.plan.entryLow)}–${fa(r.plan.entryHigh)} | ${fa(r.plan.stop)} | ${fa(r.plan.target1)} | ${fa(r.plan.rr, 1)} |`));
  md.push('');

  // Actionable entries first, then the rest of the ranking, so every buy signal gets a card.
  const buys = ok.filter(r => r.signal === 'ورود پله‌ای');
  const cards = [...buys, ...ok.filter(r => r.signal !== 'ورود پله‌ای')].slice(0, Math.max(opts.cards, buys.length));
  md.push(`## ۳. تحلیل نمادها (اول سیگنال‌های ورود، سپس بقیه به ترتیب امتیاز)`);
  for (const r of cards) md.push(symbolCard(r));

  const osAll = oversold(ok, 45);
  const os = osAll.filter(o => o.r.tech.rsi < 35);
  const pull = osAll.filter(o => o.r.tech.rsi >= 35 && isNum(o.r.tech.sma200) && o.r.tech.close > o.r.tech.sma200 && o.r.tech.sma50 > o.r.tech.sma200 && o.label !== 'در حال ریزش؛ صبر');
  const lowRsiRow = o => {
    const t = o.r.tech;
    return `| ${o.r.symbol} | ${o.r.fund.sectorName} | ${fa(t.close)} | ${fa(t.rsi, 1)} | ${o.label} | ${o.good.join('، ') || '—'} | ${o.bad.join('، ') || '—'} | ${t.support1 ? fa(t.support1.price) : '—'} | ${fa(o.r.plan.stop)} | ${fa(o.r.plan.target1)} | ${fa(o.r.plan.rr, 1)} |`;
  };
  const lowRsiHead = ['| نماد | گروه | قیمت | RSI | وضعیت | نقاط مثبت | نقاط منفی | حمایت | حد ضرر | هدف ۱ | R/R |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  if (os.length) {
    const cnt = k => os.filter(o => o.label === k).length;
    md.push(`## ۴. سهم‌های RSI پایین (زیر ۳۵ — اشباع فروش)`);
    md.push(`${fa(os.length)} سهم: ${fa(cnt('کاندید برگشت'))} کاندید برگشت · ${fa(cnt('منتظر تأیید'))} منتظر تأیید · ${fa(cnt('در حال ریزش؛ صبر'))} در حال ریزش. RSI پایین به‌تنهایی سیگنال خرید نیست؛ «کاندید برگشت» یعنی روند بلندمدت، ارزش و پول هم تأیید می‌کنند.\n`);
    md.push(...lowRsiHead, ...os.map(lowRsiRow), '');
  }
  if (pull.length) {
    md.push(`### پولبک در روند صعودی (RSI بین ۳۵ و ۴۵، بالای MA200 و MA50 > MA200)`);
    md.push(`${fa(pull.length)} سهم که در روند بلندمدت صعودی‌اند و اصلاح کرده‌اند؛ مرتب بر اساس کیفیت (بیشترین نقاط مثبت).\n`);
    md.push(...lowRsiHead, ...pull.map(lowRsiRow), '');
  }

  const avoid = ok.filter(r => r.signal === 'اجتناب').slice(-15).reverse();
  if (avoid.length) {
    md.push(`## ۵. نمادهای ضعیف (اجتناب)`);
    md.push(avoid.map(r => `- **${r.symbol}** — امتیاز ${fa(r.score)}${r.flags.length ? ` · ${r.flags.join('، ')}` : ''}`).join('\n') + '\n');
  }
  const funds = skipped.filter(s => s.fund), short = skipped.filter(s => !s.fund);
  if (funds.length) md.push(`**صندوق‌های کنار گذاشته‌شده (${fa(funds.length)}):** ${funds.map(s => s.symbol).join('، ')}\n`);
  if (short.length) md.push(`**رد شده:** ${short.map(s => `${s.symbol} (${s.skipped})`).join('، ')}\n`);

  md.push(`## روش‌شناسی`);
  md.push([
    '- امتیاز نهایی = ۳۰٪ روند + ۲۰٪ مومنتوم + ۲۵٪ جریان پول + ۲۵٪ ارزش (اگر EPS نباشد وزن‌ها بازتوزیع می‌شوند).',
    '- روند: جایگاه قیمت نسبت به MA20/50/200، ترتیب میانگین‌ها، ابر ایچیموکو، ADX و جهت DI.',
    '- مومنتوم: RSI(14)، MACD(12,26,9) و شیب هیستوگرام، بازده ۲۰ روز و قدرت نسبی ۶۰ روزه به شاخص کل.',
    '- جریان پول: خالص حقیقی ۵ و ۲۰ روز، نسبت خالص به ارزش معاملات، قدرت خریدار، حقیقی قوی (فرمول SMT) و تأیید حجم.',
    '- ارزش: P/E با EPS پیش‌بینی (یا TTM) نسبت به P/E گروه و فاصله از سقف ۵۲ هفته.',
    '- حمایت/مقاومت: نقاط چرخش فراکتالی (۳ کندل هر طرف) در ۲۵۰ روز اخیر که در بازه ۱.۵٪ ادغام شده‌اند.',
    '- حد ضرر: نیم ATR زیر نزدیک‌ترین حمایت، حداکثر ۲.۵ ATR یا ۱۲٪. هدف‌ها: مقاومت‌های بعدی؛ اگر سهم در سقف باشد ۳ و ۵ ATR.',
    '- سهم صفی (۶ روز یا بیشتر از ۲۰ روز با سقف = کف) یا رشد عمودی (بیش از ۱۰۰٪ در ۶۰ روز یا بیش از ۳۰٪ بالای MA50) سیگنال ورود نمی‌گیرد.',
    '- فیلتر ریسک ورود: عرضه حقوقی به حقیقی (خروج حقوقی ≥ ۵۰٪ ورود حقیقی ۲۰ روزه)، بیش از ۵۰٪ بالای MA200 یا ۱۵۰٪ بالای کف ۵۲ هفته، سرانه خرید زیر ۰٫۸، واگرایی منفی، حد ضرر بیش از ۷٪، نقدشوندگی زیر ۱۰ میلیارد تومان، شناوری زیر ۱۵٪ یا صف فروش در ۵ روز اخیر ← «قوی ولی پرریسک».',
    '- سیگنال «ورود پله‌ای» فقط وقتی داده می‌شود که امتیاز ≥ ۷۰، RSI < ۷۵، فاصله از MA20 < ۱۲٪، ریسک به ریوارد ≥ ۱.۲ و P/E مثبت و ≤ ۳۰ باشد.',
    '- این گزارش خروجی مکانیکی داده است و توصیه سرمایه‌گذاری نیست. اخبار، مجامع، گزارش‌های کدال و ریسک‌های سیاسی را جداگانه بررسی کنید.'
  ].join('\n'));
  return md.join('\n') + '\n';
}

function toCsv(results) {
  const cols = [
    ['symbol', r => r.symbol], ['name', r => r.name], ['sector', r => r.fund.sectorName], ['score', r => round(r.score)], ['signal', r => r.signal],
    ['trend', r => round(r.parts.trend)], ['momentum', r => round(r.parts.momentum)], ['money', r => round(r.parts.money)], ['value', r => round(r.parts.value)],
    ['close', r => r.tech.close], ['lastDate', r => r.tech.lastDate], ['ret5', r => round(r.tech.ret5)], ['ret20', r => round(r.tech.ret20)], ['ret60', r => round(r.tech.ret60)],
    ['rs60', r => round(r.rs60)], ['vsSma20', r => round(r.tech.vsSma20)], ['vsSma50', r => round(r.tech.vsSma50)], ['vsSma200', r => round(r.tech.vsSma200)],
    ['rsi', r => round(r.tech.rsi)], ['lockedDays20', r => r.tech.lockedDays20], ['sellQueueDays5', r => r.tech.sellQueueDays5], ['macdAboveSignal', r => r.tech.macd > r.tech.macdSignal], ['adx', r => round(r.tech.adx)], ['atrPct', r => round(r.tech.atrPct, 2)],
    ['cloud', r => r.tech.cloud], ['fromHigh52', r => round(r.tech.fromHigh52)], ['volRatio', r => round(r.tech.volRatio, 2)],
    ['support1', r => r.tech.support1 && Math.round(r.tech.support1.price)], ['resistance1', r => r.tech.resistance1 && Math.round(r.tech.resistance1.price)],
    ['netReal5B', r => r.flow && round(r.flow.netReal5, 2)], ['netReal20B', r => r.flow && round(r.flow.netReal20, 2)], ['power5', r => r.flow && round(r.flow.power5, 2)],
    ['smt5B', r => r.flow && round(r.flow.smt5, 2)], ['liquidityB', r => round(r.liquidityB, 2)],
    ['eps', r => r.fund.eps], ['pe', r => round(r.fund.pe, 2)], ['sectorPE', r => round(r.fund.sectorPE, 2)], ['peVsSector', r => round(r.fund.peVsSector)],
    ['entryLow', r => Math.round(r.plan.entryLow)], ['stop', r => Math.round(r.plan.stop)], ['target1', r => Math.round(r.plan.target1)], ['target2', r => Math.round(r.plan.target2)], ['rr', r => round(r.plan.rr, 2)],
    ['flags', r => r.flags.join(' | ')]
  ];
  const esc = v => { const s = v === null || v === undefined || (typeof v === 'number' && !isNum(v)) ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [cols.map(c => c[0]).join(','), ...results.map(r => cols.map(([, fn]) => esc(fn(r))).join(','))].join('\n') + '\n';
}

function run(data, opts) {
  const indexT = data.index && analyzeIndex(data.index.tedpix);
  const eqT = data.index && analyzeIndex(data.index.equalWeight);
  const results = (data.symbols || []).map(item => analyzeSymbol(item, indexT, opts));
  const ok = results.filter(r => r.tech).sort((a, b) => b.score - a.score);
  return { indexT, eqT, results, ok, markdown: renderReport(data, results, indexT, eqT, opts), csv: toCsv(ok) };
}

function parseArgs(argv) {
  const opts = { out: 'report', top: 25, cards: 12, minValue: 3, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--top') opts.top = Number(argv[++i]);
    else if (a === '--cards') opts.cards = Number(argv[++i]);
    else if (a === '--min-value') opts.minValue = Number(argv[++i]);
    else if (!opts.file) opts.file = a;
  }
  return opts;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file) {
    console.error('usage: node analysis/tse-report.js <tse-export.json.gz> [--out dir] [--top 25] [--cards 12] [--min-value 3]');
    process.exit(1);
  }
  const data = loadExport(opts.file);
  const out = run(data, opts);
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(path.join(opts.out, 'report.md'), out.markdown);
  fs.writeFileSync(path.join(opts.out, 'metrics.csv'), out.csv);
  const slim = out.ok.map(r => ({ ...r, tech: { ...r.tech, series: undefined } }));
  fs.writeFileSync(path.join(opts.out, 'metrics.json'), JSON.stringify({ exportedAt: data.exportedAt, index: out.indexT && { ...out.indexT, series: undefined }, symbols: slim }, null, 1));
  console.log(`${out.ok.length} symbols analysed → ${opts.out}/report.md, metrics.csv, metrics.json`);
}

module.exports = { oversold, loadExport, adjustPrices, technicals, moneyFlow, fundamentals, analyzeSymbol, analyzeIndex, tradePlan, run, toCsv };
