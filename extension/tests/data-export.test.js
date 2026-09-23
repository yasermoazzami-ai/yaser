const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../export-core.js');
const root = path.join(__dirname, '..');

test('data-export page loads the pure core before the page script', () => {
  const html = fs.readFileSync(path.join(root, 'data-export.html'), 'utf8');
  assert.ok(html.indexOf('export-core.js') >= 0);
  assert.ok(html.indexOf('export-core.js') < html.indexOf('data-export.js'));
});

test('manifest grants the Codal hosts the export page fetches', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  for (const h of ['https://search.codal.ir/*', 'https://excel.codal.ir/*', 'https://cdn.tsetmc.com/*']) assert.ok(m.host_permissions.includes(h), h);
});

test('dashboard links to the export page', () => {
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  assert.match(html, /href="data-export\.html"/);
});

test('Codal excel tables become one tab-separated line per row', () => {
  const html = '<table><tr><th>محصول</th><th> مبلغ فروش </th></tr>\n<tr><td>کاتد</td><td>1,234</td></tr></table>';
  assert.equal(core.tablesToText(html), 'محصول\tمبلغ فروش\nکاتد\t1,234');
});

test('compactLetters keeps only the fields the analyser needs', () => {
  const out = core.compactLetters({ Letters: [{ TracingNo: 9, Title: 't', LetterCode: 'ن-۳۰', PublishDateTime: 'd', Url: '/u', ExcelUrl: 'e', Extra: 1 }] });
  assert.deepEqual(out, [{ tracingNo: 9, title: 't', letterCode: 'ن-۳۰', publishDate: 'd', url: '/u', excelUrl: 'e' }]);
});
