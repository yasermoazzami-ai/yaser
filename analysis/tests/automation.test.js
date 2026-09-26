'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const wl = require('../watchlist');
const store = require('../store');
const live = require('../live');
const intraday = require('../intraday');
const { jalali } = require('../jalali');

function res(symbol, over = {}) {
  const tech = { close: 1000, dayHigh: 1010, dayLow: 990, lastDate: 20260923, rsi: 55, atr: 30, resistance1: { price: 1100 }, resistance2: { price: 1200 }, support1: { price: 950 }, lockedDays20: 0, ...over.tech };
  return {
    symbol, name: symbol, score: 75, signal: 'ورود پله‌ای', liquidityB: 20,
    fund: { sectorName: 'گروه', pe: 6 }, plan: { stop: 950, target1: 1100, target2: 1200, rr: 2 },
    ...over, tech
  };
}

test('jalali conversion around Nowruz and month ends', () => {
  assert.equal(jalali('2026-09-23').iso, '1405-07-01');
  assert.equal(jalali('2026-03-21').iso, '1405-01-01');
  assert.equal(jalali('2025-03-20').iso, '1403-12-30');
});

test('watchlist adds entry signals, then exits on stop and moves stop after target 1', () => {
  const state = { active: [], closed: [], updated: null };
  let ch = wl.update(state, [res('الف'), res('ب', { signal: 'زیر نظر' })], [], '2026-09-20');
  assert.deepEqual(ch.added.map(a => a.symbol), ['الف']);
  assert.equal(state.active[0].stop, 950);

  ch = wl.update(state, [res('الف', { tech: { close: 1105, dayHigh: 1110, dayLow: 1090, lastDate: 20260921 } })], [], '2026-09-21');
  assert.equal(ch.removed.length, 0);
  assert.ok(state.active[0].hitT1);
  assert.equal(state.active[0].stop, 1000, 'stop moves to entry after target 1');

  ch = wl.update(state, [res('الف', { signal: 'زیر نظر', tech: { close: 995, dayHigh: 1020, dayLow: 990, lastDate: 20260922 } })], [], '2026-09-22');
  assert.equal(ch.removed.length, 1);
  assert.match(ch.removed[0].exitReason, /حد ضرر متحرک/);
  assert.equal(state.active.length, 0);
});

test('watchlist drops a symbol whose signal turns to avoid', () => {
  const state = { active: [], closed: [], updated: null };
  wl.update(state, [res('ج')], [], 'd1');
  const ch = wl.update(state, [res('ج', { signal: 'اجتناب', score: 30, tech: { lastDate: 20260922 } })], [], 'd2');
  assert.match(ch.removed[0].exitReason, /تضعیف سیگنال/);
});

test('snapshots collapse into one bar per symbol with Persian keys', () => {
  const rows = [
    { symbol: 'فملي', snapshot_time: '2026-09-23 06:00:00+00', close_price: '100', final_price: '100', close_price_change_percent: '1', trade_value: '10' },
    { symbol: 'فملي', snapshot_time: '2026-09-23 07:00:00+00', close_price: '105', final_price: '103', close_price_change_percent: '5', trade_value: '20', real_buy_value: '15', real_sell_value: '5', real_buy_count: 3, real_sell_count: 9 }
  ];
  const s = live.summarizeSnapshots(rows).get('فملی');
  assert.equal(s.open, 100); assert.equal(s.high, 105); assert.equal(s.low, 100);
  assert.equal(s.final, 103); assert.equal(s.yesterday, 100); assert.equal(s.realBuyVal, 15);
});

test('applyDay appends one bar and one flow row, and skips days already present', () => {
  const data = { symbols: [{ symbol: 'فملي', info: {}, daily: { rows: [[20260922, 1, 1, 1, 100, 100, 99, 1, 1, 1]] }, client: { rows: [] } }], index: { tedpix: { rows: [[20260922, 5, null, null]] }, equalWeight: { rows: [] } } };
  const rec = { date: '2026-09-23', index: { index: 6, equalWeight: 2 }, symbols: { 'فملی': { open: 100, high: 105, low: 99, close: 103, last: 105, yesterday: 100, vol: 5, value: 500, rbV: 300, rsV: 200 } } };
  store.applyDay(data, rec, 320);
  store.applyDay(data, rec, 320);
  assert.equal(data.symbols[0].daily.rows.length, 2);
  assert.deepEqual(data.symbols[0].daily.rows[1].slice(0, 5), [20260923, 100, 105, 99, 103]);
  assert.equal(data.symbols[0].client.rows[0][9], 300);
  assert.equal(data.index.tedpix.rows.length, 2);
});

test('intraday scan flags smart money and watchlist stops, not weak symbols', () => {
  const snaps = new Map([
    ['قوی', { symbol: 'قوی', time: '2026-09-23 07:15:00+00', last: 1030, low: 1000, changePct: 3, value: 30e10, realBuyVal: 25e10, realSellVal: 5e10, realBuyCount: 10, realSellCount: 100 }],
    ['ضعیف', { symbol: 'ضعیف', time: '2026-09-23 07:15:00+00', last: 990, low: 980, changePct: -1, value: 30e10, realBuyVal: 10e10, realSellVal: 20e10, realBuyCount: 100, realSellCount: 10 }],
    ['واچ', { symbol: 'واچ', time: '2026-09-23 07:15:00+00', last: 940, low: 930, changePct: -4, value: 1e10, realBuyVal: 1, realSellVal: 1, realBuyCount: 1, realSellCount: 1 }]
  ]);
  const alerts = intraday.scan([res('قوی'), res('ضعیف')], snaps, [{ symbol: 'واچ', stop: 950, target1: 1100, target2: 1200, entry: 1000 }]);
  const types = alerts.map(a => `${a.symbol}:${a.type}`);
  assert.ok(types.includes('قوی:smart-money'));
  assert.ok(types.includes('واچ:wl-stop'));
  assert.ok(!types.some(t => t.startsWith('ضعیف')));
  assert.equal(intraday.tehranTime('2026-09-23 05:30:00+00'), '09:00');
});
