(function attachAlertPolicy(root, factory) {
  const api = factory();
  root.RadarAlertPolicy = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createAlertPolicy() {
  "use strict";

  // Internal money values are billion rials. 20 billion rials = 2 billion tomans.
  const BIG_INSTANT_THRESHOLD_B = 20;

  function isBigType(type) {
    return type === "bigBuy" || type === "bigSell";
  }

  function alertDeltaB(alert) {
    const value = Number(alert?.dBig ?? alert?.amountB ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  function qualifies(alert) {
    return isBigType(String(alert?.type || "")) && Math.abs(alertDeltaB(alert)) >= BIG_INSTANT_THRESHOLD_B;
  }

  return { BIG_INSTANT_THRESHOLD_B, isBigType, alertDeltaB, qualifies };
});
