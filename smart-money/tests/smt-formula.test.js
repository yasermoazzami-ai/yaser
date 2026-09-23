'use strict';
const assert = require('assert');
const { smartMoneySMT } = require('../smt-formula');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

// The three tables in the channel's pinned post: 10 sellers × 10 each.
close(smartMoneySMT({ buyValueI: 100, sellValueI: 100, buyCountI: 6, sellCountI: 10 }).strongIn, 40); // 5×10 + 50
close(smartMoneySMT({ buyValueI: 100, sellValueI: 100, buyCountI: 7, sellCountI: 10 }).strongIn, 30); // 5×10 + 2×25
close(smartMoneySMT({ buyValueI: 100, sellValueI: 100, buyCountI: 7, sellCountI: 10 }).strongIn, 30); // 6×10 + 40

// The commenter's خگستر example (million toman): (136 − 66) × 1889 ≈ 132,230.
const sellCount = 1000;
const r = smartMoneySMT({ buyValueI: 136 * 1889, sellValueI: 66 * sellCount, buyCountI: 1889, sellCountI: sellCount });
close(r.strongIn, 132230);

// Mirror case: sellers are the heavy side.
const o = smartMoneySMT({ buyValueI: 100, sellValueI: 100, buyCountI: 10, sellCountI: 6 });
close(o.strongIn, 0); close(o.strongOut, 40); close(o.strongNet, -40);

assert.strictEqual(smartMoneySMT({ buyValueI: 0, sellValueI: 10, buyCountI: 0, sellCountI: 1 }).valid, false);
console.log('smt-formula tests passed');
