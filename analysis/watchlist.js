'use strict';

// Dynamic watchlist: each trading day new entry signals join, and positions leave when
// the stop or the second target is hit, the signal weakens, or they stall too long.
// State lives in data/watchlist.json so it carries over between scheduled runs.

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'watchlist.json');
const MAX_ACTIVE = 12;
const MAX_ADDS_PER_DAY = 5;
const MAX_HOLD_DAYS = 25;

const pct = (a, b) => (b ? (a / b - 1) * 100 : NaN);

function load(file = FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { active: [], closed: [], updated: null }; }
}

function save(state, file = FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 1) + '\n');
}

function candidates(results, oversoldList) {
  const buys = results.filter(r => r.signal === 'ورود پله‌ای').map(r => ({ r, reason: 'سیگنال ورود پله‌ای' }));
  const rebounds = (oversoldList || []).filter(o => o.label === 'کاندید برگشت' && o.r.plan.rr >= 1).map(o => ({ r: o.r, reason: `برگشت از RSI پایین (${Math.round(o.r.tech.rsi)})` }));
  return [...buys, ...rebounds].sort((a, b) => b.r.score - a.r.score);
}

// results: analysed symbols of the day (tse-report analyzeSymbol output), keyed by symbol.
function update(state, results, oversoldList, date) {
  const bySymbol = new Map(results.map(r => [r.symbol, r]));
  const removed = [], kept = [], events = [];

  for (const item of state.active) {
    const r = bySymbol.get(item.symbol);
    if (!r) { kept.push(item); continue; }
    const t = r.tech;
    const high = t.dayHigh ?? t.close, low = t.dayLow ?? t.close;
    item.last = t.close;
    item.days = (item.days || 0) + (item.lastSeen === t.lastDate ? 0 : 1);
    item.lastSeen = t.lastDate;
    item.score = Math.round(r.score);
    item.signal = r.signal;
    let exit = null;
    if (low <= item.stop) exit = { reason: item.hitT1 ? 'حد ضرر متحرک (بعد از هدف ۱)' : 'حد ضرر', price: Math.min(item.stop, t.close) };
    else if (high >= item.target2) exit = { reason: 'هدف ۲', price: item.target2 };
    else if (r.signal === 'اجتناب' || r.score < 45) exit = { reason: `تضعیف سیگنال (امتیاز ${Math.round(r.score)})`, price: t.close };
    else if (item.days >= MAX_HOLD_DAYS && !item.hitT1) exit = { reason: `${MAX_HOLD_DAYS} روز بدون رسیدن به هدف`, price: t.close };
    if (!exit && !item.hitT1 && high >= item.target1) {
      item.hitT1 = date;
      item.stop = Math.max(item.stop, item.entry); // lock in: stop moves to entry
      events.push(`${item.symbol}: هدف ۱ (${item.target1}) زده شد؛ حد ضرر به قیمت ورود (${item.entry}) منتقل شد`);
    }
    if (exit) removed.push({ ...item, closedAt: date, exitReason: exit.reason, exitPrice: Math.round(exit.price), resultPct: pct(exit.price, item.entry) });
    else kept.push(item);
  }

  const activeSet = new Set(kept.map(i => i.symbol));
  const recentlyClosed = new Set(state.closed.filter(c => c.closedAt === date).map(c => c.symbol));
  const added = [];
  for (const c of candidates(results, oversoldList)) {
    if (kept.length + added.length >= MAX_ACTIVE || added.length >= MAX_ADDS_PER_DAY) break;
    if (activeSet.has(c.r.symbol) || recentlyClosed.has(c.r.symbol) || removed.some(x => x.symbol === c.r.symbol)) continue;
    const p = c.r.plan;
    added.push({
      symbol: c.r.symbol, name: c.r.name, sector: c.r.fund.sectorName, addedAt: date, reason: c.reason,
      entry: Math.round(c.r.tech.close), stop: Math.round(p.stop), target1: Math.round(p.target1), target2: Math.round(p.target2),
      rr: Math.round(p.rr * 100) / 100, score: Math.round(c.r.score), signal: c.r.signal, last: c.r.tech.close, days: 0, lastSeen: c.r.tech.lastDate
    });
  }

  state.active = [...kept, ...added];
  state.closed = [...removed, ...state.closed].slice(0, 200);
  state.updated = date;
  return { added, removed, events };
}

const fa = (v, d = 0) => (Number.isFinite(v) ? Number(v.toFixed(d)).toLocaleString('fa-IR') : '—');
const faPct = v => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${fa(v, 1)}٪` : '—');

function render(state, change) {
  const md = [];
  md.push(`## واچ‌لیست پویا (${fa(state.active.length)} نماد فعال)`);
  if (change.added.length) {
    md.push(`**اضافه‌شده امروز:**`);
    for (const a of change.added) md.push(`- **${a.symbol}** (${a.sector}) — ${a.reason} · ورود ${fa(a.entry)} · حد ضرر ${fa(a.stop)} · هدف ${fa(a.target1)} / ${fa(a.target2)} · R/R ${fa(a.rr, 1)}`);
  } else md.push('**اضافه‌شده امروز:** هیچ سهمی شرایط ورود نداشت.');
  if (change.removed.length) {
    md.push(`\n**خارج‌شده امروز:**`);
    for (const x of change.removed) md.push(`- **${x.symbol}** — ${x.exitReason} · ورود ${fa(x.entry)} → ${fa(x.exitPrice)} (${faPct(x.resultPct)}) · ${fa(x.days)} روز`);
  }
  if (change.events.length) md.push(`\n**رویدادها:**\n${change.events.map(e => `- ${e}`).join('\n')}`);
  if (state.active.length) {
    md.push(`\n| نماد | از تاریخ | دلیل | ورود | آخرین | سود/زیان | حد ضرر | هدف ۱ | هدف ۲ | امتیاز | سیگنال امروز |`);
    md.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const a of state.active) md.push(`| ${a.symbol} | ${a.addedAt} | ${a.reason} | ${fa(a.entry)} | ${fa(a.last)} | ${faPct(pct(a.last, a.entry))} | ${fa(a.stop)} | ${fa(a.target1)}${a.hitT1 ? ' ✓' : ''} | ${fa(a.target2)} | ${fa(a.score)} | ${a.signal} |`);
  }
  const done = state.closed.filter(c => Number.isFinite(c.resultPct));
  if (done.length) {
    const wins = done.filter(c => c.resultPct > 0).length;
    md.push(`\nکارنامه: ${fa(done.length)} معامله بسته‌شده · ${fa(wins / done.length * 100)}٪ سودده · میانگین ${faPct(done.reduce((s, c) => s + c.resultPct, 0) / done.length)}`);
  }
  return md.join('\n') + '\n';
}

module.exports = { FILE, load, save, candidates, update, render };
