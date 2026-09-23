'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../extension/export-core');
const report = require('../tse-report');
const fx = require('./fixtures');

function item(symbol, opts) {
  return {
    insCode: String(1e10 + symbol.length), symbol, name: `شرکت ${symbol}`, errors: [],
    daily: { columns: core.DAILY_COLUMNS, rows: core.compactDaily(fx.dailyJson(opts.daily), 320) },
    client: { columns: core.CLIENT_COLUMNS, rows: core.compactClient(fx.clientJson(opts.client), 320) },
    info: core.compactInfo(fx.infoJson({ symbol, ...opts.info }))
  };
}

function exportFixture() {
  return {
    schema: core.SCHEMA_VERSION, exportedAt: '2026-09-23T10:00:00Z',
    index: { tedpix: { columns: core.INDEX_COLUMNS, rows: core.compactIndex(fx.indexJson(), 320) }, equalWeight: { columns: core.INDEX_COLUMNS, rows: [] } },
    symbols: [
      item('صعودی', { daily: { drift: 0.6, seed: 3 }, client: { inflow: 1 }, info: { eps: 2500, sectorPE: 8 } }),
      item('نزولی', { daily: { drift: -0.6, seed: 4 }, client: { inflow: -1 }, info: { eps: 300, sectorPE: 8 } }),
      item('کوتاه', { daily: { n: 30 }, client: {}, info: {} })
    ]
  };
}

test('compactDaily sorts oldest-first, drops zero-volume days and trims', () => {
  const rows = core.compactDaily(fx.dailyJson({ n: 50 }), 40);
  assert.equal(rows.length, 40);
  assert.ok(rows[0][0] < rows[39][0]);
  assert.ok(rows.every(r => r[7] > 0));
});

test('compactClient keeps real/legal values and counts', () => {
  const rows = core.compactClient(fx.clientJson({ n: 10 }));
  assert.equal(rows.length, 10);
  const col = name => core.CLIENT_COLUMNS.indexOf(name);
  assert.ok(rows[0][col('buyIVal')] > rows[0][col('sellIVal')]);
  assert.equal(rows[0][col('buyICount')], 300);
});

test('parseUniverse drops rights and funds and dedupes by insCode', () => {
  const mw = { marketwatch: [
    { insCode: '111111', lva: 'فملی', lvc: 'ملی صنایع مس', qtc: 5e12 },
    { insCode: '111111', lva: 'فملی', lvc: 'ملی صنایع مس', qtc: 6e12 },
    { insCode: '222222', lva: 'فملیح', lvc: 'ح . ملی صنایع مس', qtc: 1e11 },
    { insCode: '333333', lva: 'اهرم', lvc: 'صندوق اهرمی کاریزما', qtc: 9e12 }
  ] };
  const u = core.parseUniverse([mw]);
  assert.equal(u.length, 3);
  assert.equal(u.find(r => r.insCode === '111111').value, 6e12);
  assert.deepEqual(u.filter(r => r.equity).map(r => r.symbol), ['فملی']);
});

test('parseWatchlist normalises Arabic ye/kaf and separators', () => {
  assert.deepEqual(core.parseWatchlist('فملي، كگهر,شپنا  فملی'), ['فملی', 'کگهر', 'شپنا']);
});

test('adjustPrices removes a capital-increase gap', () => {
  const rows = core.compactDaily(fx.dailyJson({ n: 120, drift: 0, vol: 0.5, splitAt: 60 }));
  const bars = rows.map(r => Object.fromEntries(core.DAILY_COLUMNS.map((c, i) => [c, r[i]])));
  const { bars: adj, events } = report.adjustPrices(bars);
  assert.equal(events.length, 1);
  const gap = adj[60].yesterday / adj[59].close;
  assert.ok(Math.abs(gap - 1) < 0.01, `adjusted gap ${gap}`);
  assert.ok(adj[0].close < bars[0].close * 0.6);
});

test('end to end: uptrend with inflow outranks downtrend with outflow', () => {
  const out = report.run(exportFixture(), { top: 10, cards: 5, minValue: 0 });
  assert.equal(out.ok.length, 2);
  const [first, second] = out.ok;
  assert.equal(first.symbol, 'صعودی');
  assert.ok(first.score > second.score + 20, `${first.score} vs ${second.score}`);
  assert.ok(first.flow.netReal5 > 0 && second.flow.netReal5 < 0);
  assert.ok(first.plan.stop < first.tech.close && first.plan.target1 > first.tech.close);
  assert.equal(second.signal, 'اجتناب');
  assert.ok(out.results.find(r => r.symbol === 'کوتاه').skipped);
  assert.match(out.markdown, /## ۲\. رتبه‌بندی/);
  assert.match(out.markdown, /### صعودی/);
  assert.match(out.csv.split('\n')[0], /^﻿symbol,name,sector,score/);
});
