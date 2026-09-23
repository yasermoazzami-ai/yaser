const test = require('node:test');
const assert = require('node:assert/strict');
const trend = require('../symbol-trend.js');
const fs = require('node:fs');
const path = require('node:path');

function p(t,b,r,power,d='20260822'){ return {t,d,b,r,p:power,s:power?1/power:0}; }

test('trend append keeps a baseline and records later changed points', () => {
  let a=[];
  a=trend.append(a,p(1000,2,4,1.1),{minGapMs:10000});
  assert.equal(a.length,1);
  a=trend.append(a,p(5000,2.1,4.1,1.11),{minGapMs:10000});
  assert.equal(a.length,1, 'small changes before min gap update the sampling bucket instead of adding noise');
  assert.equal(a[0].t,1000, 'sampling bucket timestamp must not slide on every 1-second update');
  a=trend.append(a,p(12000,2.2,4.2,1.12),{minGapMs:10000});
  assert.equal(a.length,2, 'a second point must be created after the sampling interval even for gradual moves');
});

test('real-money trend reports strengthening when recent net rises materially', () => {
  const h=[p(0,0,1,1),p(10000,0,2,1.05),p(20000,0,5,1.1)];
  const i=trend.metricInfo(h,'r','money');
  assert.equal(i.direction,1);
  assert.match(i.label,/تقویت/);
});

test('buyer-power trend reports weakening when buyer power falls', () => {
  const h=[p(0,0,0,1.5),p(10000,0,0,1.25),p(20000,0,0,0.9)];
  const i=trend.metricInfo(h,'p','power');
  assert.equal(i.direction,-1);
  assert.match(i.label,/تضعیف/);
});

test('symbol trend script loads before dashboard and dashboard exposes all three per-symbol metrics', () => {
  const root=path.join(__dirname,'..');
  const html=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
  const js=fs.readFileSync(path.join(root,'dashboard.js'),'utf8');
  assert.ok(html.indexOf('symbol-trend.js') >= 0);
  assert.ok(html.indexOf('symbol-trend.js') < html.indexOf('dashboard.js'));
  assert.match(js,/v720TrendMetric\(hist,'r','money','حقیقی'\)/);
  assert.match(js,/v720TrendMetric\(hist,'b','money','درشت'\)/);
  assert.match(js,/v720TrendMetric\(hist,'p','power','قدرت خرید'\)/);
  assert.match(js,/canGenerateAlerts/);
  assert.match(js,/!r\?\.liveSessionData \|\| !r\?\.hasClient/);
});
