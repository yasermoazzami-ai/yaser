#!/usr/bin/env node
'use strict';

// Scheduled end-of-day job: capture today's session from the live source, append it to
// the stored history, rebuild the full-market report and update the dynamic watchlist.
//
//   node analysis/daily.js                    fetch today, report, update watchlist
//   node analysis/daily.js --import <export>  replace the base history with a new
//                                             extension export first
//   node analysis/daily.js --no-fetch         rebuild from stored data only
//
// Writes reports/<date>/{report.md,metrics.csv,summary.md}, reports/latest.md,
// data/daily/<date>.json.gz and data/watchlist.json. Prints the summary.

const fs = require('node:fs');
const path = require('node:path');
const live = require('./live');
const store = require('./store');
const report = require('./tse-report');
const wl = require('./watchlist');
const { jalali } = require('./jalali');

const REPORTS = path.join(__dirname, '..', 'reports');
const fa = (v, d = 0) => (Number.isFinite(v) ? Number(v.toFixed(d)).toLocaleString('fa-IR') : '—');

function args(argv) {
  const o = { fetch: true, import: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-fetch') o.fetch = false;
    else if (argv[i] === '--import') o.import = argv[++i];
  }
  return o;
}

async function capture(state) {
  const [indices, snap] = await Promise.all([live.getMarketIndices(), live.getMarketSnapshots()]);
  const file = path.join(store.DAILY, `${snap.date}.json.gz`);
  // Re-capture only if the stored day was taken while the market was still open.
  if (fs.existsSync(file) && !store.readGz(file).partial) return { date: snap.date, file, fresh: false, indices };
  // Exact OHLC and legal flow for the watchlist (a handful of requests).
  const details = new Map();
  for (const item of state.active) {
    try { const d = await live.getSymbolData(item.symbol); if (d) details.set(live.faKey(item.symbol), d); }
    catch (e) { console.error(`symbol-data ${item.symbol}: ${e.message}`); }
  }
  const rec = store.dayRecord(snap.date, snap.symbols, details, indices);
  rec.partial = indices.state === 'open';
  store.saveDay(rec);
  return { date: snap.date, file, fresh: true, indices, count: Object.keys(rec.symbols).length, open: indices.state === 'open' };
}

function summary(date, out, change, indices, cap) {
  const t = out.indexT;
  const counts = {};
  for (const r of out.ok) counts[r.signal] = (counts[r.signal] || 0) + 1;
  const lines = [
    `📊 گزارش بورس ${jalali(date).label}`,
    t ? `شاخص کل ${fa(t.close)} (${t.chg1d > 0 ? '+' : ''}${fa(t.chg1d, 2)}٪) · RSI ${fa(t.rsi)} · ${t.close > t.sma20 ? 'بالای' : 'زیر'} MA20` : '',
    `${fa(out.ok.length)} سهم: ${fa(counts['ورود پله‌ای'] || 0)} ورود پله‌ای · ${fa(counts['اجتناب'] || 0)} اجتناب`,
    change.added.length ? `➕ واچ‌لیست: ${change.added.map(a => `${a.symbol} (ورود ${fa(a.entry)}، ضرر ${fa(a.stop)}، هدف ${fa(a.target1)})`).join('، ')}` : '➕ امروز سهم جدیدی به واچ‌لیست اضافه نشد',
    change.removed.length ? `➖ خروج: ${change.removed.map(x => `${x.symbol} ${x.exitReason} (${x.resultPct > 0 ? '+' : ''}${fa(x.resultPct, 1)}٪)`).join('، ')}` : '',
    ...change.events.map(e => `🎯 ${e}`),
    cap && cap.open ? '⚠️ بازار هنوز باز بود؛ داده امروز ناقص است.' : ''
  ];
  return lines.filter(Boolean).join('\n');
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.import) {
    const b = store.importBase(o.import);
    console.error(`base history imported: ${b.symbols.length} symbols`);
  }
  const state = wl.load();
  let cap = null;
  if (o.fetch) {
    cap = await capture(state);
    console.error(`live day ${cap.date}: ${cap.fresh ? `${cap.count} symbols captured` : 'already captured'}`);
    if (!cap.fresh && !o.import) {
      console.log(`امروز جلسه معاملاتی جدیدی ثبت نشد (تعطیلی یا داده منبع به‌روز نشده). آخرین جلسه: ${cap.date} — گزارش همان روز در reports/latest.md است.`);
      return;
    }
  }
  const data = store.loadHistory();
  const date = data.lastDate;
  data.exportedAt = `${date} (پایه: ${String(data.exportedAt).slice(0, 10)}، روزهای افزوده: ${data.appliedDays.length})`;
  const out = report.run(data, { top: 40, cards: 25, minValue: 3 });
  const oversold = report.oversold(out.ok, 45);
  const jdate = jalali(date).iso;
  const change = state.updated === jdate ? { added: [], removed: [], events: [] } : wl.update(state, out.ok, oversold, jdate);
  wl.save(state);

  const dir = path.join(REPORTS, jalali(date).iso);
  fs.mkdirSync(dir, { recursive: true });
  const text = summary(date, out, change, cap && cap.indices, cap);
  const md = out.markdown.replace(/\n## ۱\. وضعیت بازار/, `\n> ${text.split('\n').join('\n> ')}\n\n${wl.render(state, change)}\n## ۱. وضعیت بازار`);
  fs.writeFileSync(path.join(dir, 'report.md'), md);
  fs.writeFileSync(path.join(dir, 'metrics.csv'), out.csv);
  fs.writeFileSync(path.join(dir, 'summary.md'), text + '\n');
  fs.writeFileSync(path.join(REPORTS, 'latest.md'), md);
  console.log(text);
}

if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exit(1); });
