#!/usr/bin/env node
'use strict';

// Intraday scan (scheduled hourly during the 09:00–12:30 Tehran session): compares the
// live session with yesterday's analysis and reports stocks showing strength now, plus
// watchlist stops/targets being touched. Alerts already sent today are not repeated.
//
//   node analysis/intraday.js [--force]   (--force: run even when the market is closed)
//
// Appends to reports/intraday/<date>.md and prints only the new alerts.

const fs = require('node:fs');
const path = require('node:path');
const live = require('./live');
const store = require('./store');
const report = require('./tse-report');
const wl = require('./watchlist');

const OUT = path.join(__dirname, '..', 'reports', 'intraday');
const SEEN = path.join(__dirname, '..', 'data', 'intraday-seen.json');
const B = 1e10; // rial → billion toman
const fa = (v, d = 0) => (Number.isFinite(v) ? Number(v.toFixed(d)).toLocaleString('fa-IR') : '—');
const sgn = v => (v > 0 ? '+' : '');

// Fraction of the 09:00–12:30 Tehran session (05:30–09:00 UTC) elapsed at snapshot time.
function sessionFraction(isoUtc) {
  const m = String(isoUtc).match(/(\d{2}):(\d{2})/);
  if (!m) return 1;
  const mins = Number(m[1]) * 60 + Number(m[2]) - (5 * 60 + 30);
  return Math.min(1, Math.max(0.1, mins / 210));
}

function tehranTime(isoUtc) {
  const m = String(isoUtc).match(/(\d{2}):(\d{2})/);
  if (!m) return '';
  const t = Number(m[1]) * 60 + Number(m[2]) + 210;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function scan(results, snaps, watch) {
  const alerts = [];
  const bySym = new Map(results.map(r => [live.faKey(r.symbol), r]));
  for (const [key, s] of snaps) {
    const r = bySym.get(key);
    if (!r || !(s.value > 0)) continue;
    const t = r.tech, fd = r.fund;
    const frac = sessionFraction(s.time);
    const avgValue = r.liquidityB * B;
    const valueRatio = avgValue > 0 ? s.value / (avgValue * frac) : NaN;
    const pcb = s.realBuyCount > 0 ? s.realBuyVal / s.realBuyCount : NaN;
    const pcs = s.realSellCount > 0 ? s.realSellVal / s.realSellCount : NaN;
    const power = pcb / pcs;
    const netReal = (s.realBuyVal - s.realSellVal) / B;
    const pct = s.changePct;
    const liquid = r.liquidityB >= 3;
    const valueOk = fd.pe > 0 && fd.pe <= 30;
    const base = { symbol: r.symbol, sector: fd.sectorName, price: s.last, pct, valueRatio, power, netReal, score: Math.round(r.score), time: tehranTime(s.time), plan: r.plan, tech: t, risks: r.risks || [] };

    const r1 = t.resistance1 && t.resistance1.price;
    if (liquid && r1 && t.close < r1 && s.last > r1 * 1.005 && pct > 0 && valueRatio >= 1.2 && power >= 1.2 && r.score >= 50) {
      // After a breakout the broken level is the new floor and the next level the target.
      const plan = { stop: r1 - 0.5 * t.atr, target1: t.resistance2 ? t.resistance2.price : s.last + 3 * t.atr };
      alerts.push({ ...base, plan, type: 'breakout', title: 'شکست مقاومت با حجم', detail: `مقاومت ${fa(r1)} شکسته شد` });
    }
    if (liquid && valueOk && pct > 0.5 && power >= 2 && netReal >= Math.max(3, 0.15 * s.value / B) && valueRatio >= 1 && r.score >= 50) {
      alerts.push({ ...base, type: 'smart-money', title: 'ورود پول هوشمند', detail: `سرانه خرید ${fa(power, 1)} برابر فروش، خالص حقیقی ${sgn(netReal)}${fa(netReal, 1)} میلیارد تومان` });
    }
    const s1 = t.support1 && t.support1.price;
    if (liquid && valueOk && t.rsi < 40 && pct >= 1.5 && power >= 1.5 && netReal > 0 && s1 && s.low <= s1 * 1.03) {
      alerts.push({ ...base, type: 'rebound', title: 'برگشت از حمایت', detail: `RSI دیروز ${fa(t.rsi)}، واکنش به حمایت ${fa(s1)}` });
    }
  }
  for (const w of watch) {
    const s = snaps.get(live.faKey(w.symbol));
    if (!s) continue;
    if (s.last <= w.stop) alerts.push({ symbol: w.symbol, type: 'wl-stop', title: 'واچ‌لیست: حد ضرر', detail: `قیمت ${fa(s.last)} ≤ حد ضرر ${fa(w.stop)} (ورود ${fa(w.entry)})`, price: s.last, pct: s.changePct, time: tehranTime(s.time) });
    else if (s.last >= (w.hitT1 ? w.target2 : w.target1)) alerts.push({ symbol: w.symbol, type: w.hitT1 ? 'wl-t2' : 'wl-t1', title: `واچ‌لیست: هدف ${w.hitT1 ? '۲' : '۱'}`, detail: `قیمت ${fa(s.last)} به هدف ${fa(w.hitT1 ? w.target2 : w.target1)} رسید (ورود ${fa(w.entry)})`, price: s.last, pct: s.changePct, time: tehranTime(s.time) });
  }
  const rank = a => (a.type.startsWith('wl') ? 1e6 : 0) + (a.score || 0) + (a.power || 0) * 5;
  return alerts.sort((a, b) => rank(b) - rank(a));
}

function render(alerts, date, time) {
  const lines = [`### ${time} — ${fa(alerts.length)} هشدار جدید`];
  for (const a of alerts) {
    const plan = a.plan ? ` · حد ضرر ${fa(a.plan.stop)} · هدف ${fa(a.plan.target1)}` : '';
    const stats = Number.isFinite(a.valueRatio) ? ` · حجم ${fa(a.valueRatio, 1)}× میانگین · امتیاز ${fa(a.score)}` : '';
    const warn = [...(a.tech && a.tech.lockedDays20 >= 6 ? ['سهم صفی'] : []), ...(a.risks || [])];
    const flags = warn.length ? ` · ⚠️ ${warn.join('، ')}` : ' · ✅ بدون پرچم ریسک';
    lines.push(`- **${a.symbol}** (${a.title}) — ${fa(a.price)} (${sgn(a.pct)}${fa(a.pct, 1)}٪): ${a.detail}${stats}${plan}${flags}`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const force = process.argv.includes('--force');
  const [indices, snap] = await Promise.all([live.getMarketIndices(), live.getMarketSnapshots()]);
  if (indices.state !== 'open' && !force) {
    console.log(`بازار باز نیست (وضعیت: ${indices.state || 'نامشخص'})؛ اسکن انجام نشد.`);
    return;
  }
  const data = store.loadHistory({ before: snap.date });
  const out = report.run(data, { top: 1, cards: 0, minValue: 3 });
  const watch = wl.load().active;
  const all = scan(out.ok, snap.symbols, watch);

  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(SEEN, 'utf8')); } catch { /* first run */ }
  if (seen.date !== snap.date) seen = { date: snap.date, keys: [] };
  const fresh = all.filter(a => !seen.keys.includes(`${a.symbol}|${a.type}`)).slice(0, 12);
  seen.keys.push(...fresh.map(a => `${a.symbol}|${a.type}`));
  fs.mkdirSync(path.dirname(SEEN), { recursive: true });
  fs.writeFileSync(SEEN, JSON.stringify(seen) + '\n');

  const lastTime = tehranTime([...snap.symbols.values()].map(s => s.time).sort().pop());
  const idx = `شاخص کل ${fa(indices.index)} (${sgn(indices.changePct)}${fa(indices.changePct, 2)}٪)`;
  if (!fresh.length) { console.log(`⏱ ${lastTime} · ${idx} · هشدار جدیدی نیست.`); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const md = render(fresh, snap.date, lastTime);
  fs.appendFileSync(path.join(OUT, `${snap.date}.md`), md + '\n');
  console.log(`⏱ ${lastTime} · ${idx}\n${md}`);
}

module.exports = { scan, sessionFraction, tehranTime };
if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exit(1); });
