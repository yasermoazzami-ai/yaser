'use strict';

// "حقیقی قوی" (strong real money) as defined by the Smart Money Tracker channel:
// buyers whose per-capita is above the sellers' per-capita bring in the excess.
//   strongIn  = BuyCountI  × (buyPerCapita  − sellPerCapita)   when buyPerCapita  > sellPerCapita
//   strongOut = SellCountI × (sellPerCapita − buyPerCapita)    when sellPerCapita > buyPerCapita
// Equivalently strongIn = BuyValueI − BuyCountI × sellPerCapita. Only one side is non-zero.
// Units: whatever unit the values are passed in (e.g. billion rial); counts are code counts.
function smartMoneySMT({ buyValueI, sellValueI, buyCountI, sellCountI }) {
  const B = Number(buyValueI) || 0, S = Number(sellValueI) || 0;
  const nb = Number(buyCountI) || 0, ns = Number(sellCountI) || 0;
  if (!(B > 0 && S > 0 && nb > 0 && ns > 0)) {
    return { buyPerCapita: 0, sellPerCapita: 0, strongIn: 0, strongOut: 0, strongNet: 0, valid: false };
  }
  const bpc = B / nb, spc = S / ns;
  const strongIn = bpc > spc ? nb * (bpc - spc) : 0;
  const strongOut = spc > bpc ? ns * (spc - bpc) : 0;
  return { buyPerCapita: bpc, sellPerCapita: spc, strongIn, strongOut, strongNet: strongIn - strongOut, valid: true };
}

module.exports = { smartMoneySMT };
