'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ind = require('../indicators');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('sma aligns with input and is NaN before the window fills', () => {
  const s = ind.sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(s[1]));
  close(s[2], 2); close(s[4], 4);
});

test('ema seeds with the simple mean then smooths', () => {
  const e = ind.ema([2, 4, 6, 8], 2);
  close(e[1], 3);
  close(e[2], 6 * (2 / 3) + 3 * (1 / 3));
});

test('rsi is 100 for a strictly rising series and 50 for a flat one', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  close(ind.last(ind.rsi(up, 14)), 100);
  close(ind.last(ind.rsi(new Array(40).fill(7), 14)), 50);
  assert.ok(Number.isNaN(ind.rsi(up, 14)[13]), 'first RSI value needs 14 changes');
});

test('rsi matches the Wilder reference on a known series', () => {
  // First RSI = 100 − 100/(1 + avgGain/avgLoss) over the first 14 changes (gains 3.34, losses 1.40).
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  close(ind.rsi(c, 14)[14], 100 - 100 / (1 + 3.34 / 1.40), 1e-6);
});

test('atr of a constant-range series equals the range', () => {
  const h = new Array(30).fill(11), l = new Array(30).fill(9), c = new Array(30).fill(10);
  close(ind.last(ind.atr(h, l, c, 14)), 2);
});

test('macd is positive and above signal in an accelerating uptrend', () => {
  const c = Array.from({ length: 80 }, (_, i) => 100 * 1.01 ** (i * i / 40));
  const m = ind.macd(c);
  assert.ok(ind.last(m.line) > 0);
  assert.ok(ind.last(m.line) > ind.last(m.signal));
});

test('adx is high with +DI dominant in a steady uptrend', () => {
  const c = Array.from({ length: 80 }, (_, i) => 100 + i);
  const d = ind.adx(c.map(v => v + 0.5), c.map(v => v - 0.5), c, 14);
  assert.ok(ind.last(d.adx) > 50);
  assert.ok(ind.last(d.plusDI) > ind.last(d.minusDI));
});

test('swings and levels find a repeated support', () => {
  const low = [10, 9, 8, 7, 8, 9, 10, 9, 8, 7.05, 8, 9, 10];
  const high = low.map(v => v + 1);
  const sw = ind.swings(high, low, 2);
  assert.equal(sw.lows.length, 2);
  const lv = ind.levels(sw.lows, 1.5);
  assert.equal(lv.length, 1);
  assert.equal(lv[0].touches, 2);
});
