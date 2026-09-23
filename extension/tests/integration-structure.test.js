const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('formula engine loads before dashboard', () => {
  const html = fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
  assert.ok(html.indexOf('formula-engine.js') >= 0);
  assert.ok(html.indexOf('formula-engine.js') < html.indexOf('dashboard.js'));
});

test('dashboard has only one canonical buildRows and normClient', () => {
  const js = fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
  assert.equal((js.match(/^function buildRows\s*\(/gm)||[]).length, 1);
  assert.equal((js.match(/^function normClient\s*\(/gm)||[]).length, 1);
});

test('legacy 0.1 big-money unit multiplier is not active', () => {
  const js = fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
  assert.doesNotMatch(js, /MOJ3_TOMAN_UNIT_FIX\s*=\s*0\.1/);
  assert.doesNotMatch(js, /bigMoneyB[^\n]*\*\s*0\.1/);
});

test('market-session guard loads before dashboard', () => {
  const html = fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
  assert.ok(html.indexOf('market-session.js') >= 0);
  assert.ok(html.indexOf('market-session.js') < html.indexOf('dashboard.js'));
});

test('v7.3 keeps the v7.1 stale-session guard and v7.2 trend cache namespace', () => {
  const js = fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
  assert.match(js, /7\.3\.0-main-radar-trends/);
  assert.match(js, /tsetmcStocksRadar_v720_symbol_trends_state/);
  assert.match(js, /sessionBlocked:true/);
  assert.match(js, /rowFreshForCurrentSession/);
});

test('fixed-income symbols visible in the bug screenshot are excluded from equity universe', () => {
  const js = fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
  const equity = js.match(/const EQUITY_FUND_EXACT = new Set\(\[([\s\S]*?)\]\.map\(compactKey\)\);/)[1];
  const fixed = js.match(/const FIXED_INCOME_FUND_EXACT = new Set\(\[([\s\S]*?)\]\.map\(compactKey\)\);/)[1];
  for (const sym of ['دارا','آفاق','صایند']) {
    assert.equal(equity.includes(`'${sym}'`), false, `${sym} must not be equity allowlisted`);
    assert.equal(fixed.includes(`'${sym}'`), true, `${sym} must be fixed-income denylisted`);
  }
});

test('ClientType JSON is preferred and legacy CSV uses documented column order', () => {
  const js = fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
  const jsonPos = js.indexOf('https://cdn.tsetmc.com/api/ClientType/GetClientTypeAll');
  const oldPos = js.indexOf('https://old.tsetmc.com/tsev2/data/ClientTypeAll.aspx');
  assert.ok(jsonPos >= 0 && oldPos >= 0 && jsonPos < oldPos);
  assert.match(js, /csv:documented-clienttypeall/);
  assert.match(js, /clientVolumeConsistencyV710/);
});


test('v7.3 exposes per-symbol trend block in all six main-radar lists', () => {
  const js = fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
  for (const id of ['topBigIn','topBigOut','topRealIn','topRealOut','topBattleBuy','topBattleSell']) {
    assert.ok(js.includes(`'${id}'`), `${id} should be trend-enabled`);
  }
  assert.match(js, /radarInlineTrend/);
  assert.match(js, /miniBigTrendSpark\(x\)/);
});
