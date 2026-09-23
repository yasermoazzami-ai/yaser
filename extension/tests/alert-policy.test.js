const test = require("node:test");
const assert = require("node:assert/strict");
const Policy = require("../alert-policy.js");

test("uses 2 billion tomans as 20 billion rials internally", () => {
  assert.equal(Policy.BIG_INSTANT_THRESHOLD_B, 20);
});

test("accepts only instant big-money alerts at or above the threshold", () => {
  assert.equal(Policy.qualifies({ type: "bigBuy", dBig: 20 }), true);
  assert.equal(Policy.qualifies({ type: "bigSell", dBig: -25 }), true);
  assert.equal(Policy.qualifies({ type: "bigBuy", dBig: 19.999 }), false);
  assert.equal(Policy.qualifies({ type: "realBuy", dBig: 80, amountB: 80 }), false);
});

test("falls back to amount for cached big-money alerts", () => {
  assert.equal(Policy.qualifies({ type: "bigBuy", amountB: 22 }), true);
  assert.equal(Policy.qualifies({ type: "bigSell", amountB: -9.52 }), false);
});
