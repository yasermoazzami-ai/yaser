const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../market-session.js');
function utc(iso){ return new Date(iso); }

test('08:35 Tehran is pre-open but time-unlocked radar may still refresh', () => {
  const s = S.current(utc('2026-08-22T05:05:00Z'));
  assert.equal(s.phase, 'pre-open');
  assert.equal(S.canGenerateAlerts(s), true);
  assert.equal(S.shouldZeroLiveMetrics(s), false);
});

test('09:05 Tehran is main session and may generate alerts', () => {
  const s = S.current(utc('2026-08-22T05:35:00Z'));
  assert.equal(s.phase, 'main');
  assert.equal(S.canGenerateAlerts(s), true);
});

test('Thursday and Friday are closed regular weekdays', () => {
  const thu = S.current(utc('2026-08-20T07:00:00Z'));
  const fri = S.current(utc('2026-08-21T07:00:00Z'));
  assert.equal(thu.phase, 'closed-day');
  assert.equal(fri.phase, 'closed-day');
  assert.equal(S.canGenerateAlerts(thu), false);
  assert.equal(S.canGenerateAlerts(fri), false);
});

test('stale previous-session hEven cannot masquerade as future data', () => {
  const s = S.current(utc('2026-08-22T05:35:00Z'));
  assert.equal(S.rowFreshForCurrentSession({hEven:123000}, s, false), false);
  assert.equal(S.rowFreshForCurrentSession({hEven:90400}, s, false), true);
});

test('explicit dEven must match Tehran trading date', () => {
  const s = S.current(utc('2026-08-22T05:35:00Z'));
  assert.equal(S.rowFreshForCurrentSession({dEven:20260822,hEven:1}, s, false), true);
  assert.equal(S.rowFreshForCurrentSession({dEven:20260819,hEven:90400}, s, false), false);
});

test('pre-open same-day row is accepted by time-unlocked mode', () => {
  const s = S.current(utc('2026-08-22T05:05:00Z'));
  assert.equal(S.rowFreshForCurrentSession({dEven:20260822,hEven:83500}, s, false), true);
});

test('12:35 Tehran remains enabled in time-unlocked mode', () => {
  const s = S.current(utc('2026-08-22T09:05:00Z'));
  assert.equal(s.phase, 'mid-break');
  assert.equal(S.canGenerateAlerts(s), true);
});
