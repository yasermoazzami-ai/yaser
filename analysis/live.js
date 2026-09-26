'use strict';

// Live market data from tablokhani.com's public API, reachable from outside Iran
// (TSETMC and Codal are not). Used by the scheduled daily report and intraday scan.
//
//   market-snapshots : every symbol, 10-minute snapshots of the current/last session
//                      (last & final price, change %, trade value, real buy/sell
//                      volume/value/count)
//   symbol-data      : one symbol's full day (OHLC, volume, real & legal flow, EPS, P/E)
//   market-indices   : TEDPIX and Farabourse index for the current/last session
//
// This is an unofficial third-party source: keep requests few and tolerate changes.

const API = 'https://api.tablokhani.com/public';
const faKey = s => String(s || '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, '').trim();
const num = v => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function getJson(url, { retries = 2, timeoutMs = 120000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

// Collapses the 10-minute snapshots into one intraday bar per symbol.
// open/high/low come from the snapshots' last-trade prices, so they approximate the
// true session range (exact for symbols fetched with symbol-data).
function summarizeSnapshots(rows) {
  const bySymbol = new Map();
  for (const r of rows) {
    const key = faKey(r.symbol);
    const last = num(r.close_price);
    if (!key || !(last > 0)) continue;
    let s = bySymbol.get(key);
    if (!s) { s = { symbol: key, points: [] }; bySymbol.set(key, s); }
    s.points.push({ t: r.snapshot_time, last, final: num(r.final_price), pct: num(r.close_price_change_percent), value: num(r.trade_value), row: r });
  }
  const out = new Map();
  for (const [key, s] of bySymbol) {
    s.points.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const traded = s.points.filter(p => p.value > 0);
    const lastPt = s.points[s.points.length - 1];
    const r = lastPt.row;
    const prices = traded.map(p => p.last);
    const pct = lastPt.pct;
    const yesterday = isFinite(pct) && pct > -100 ? Math.round(lastPt.last / (1 + pct / 100)) : null;
    out.set(key, {
      symbol: key,
      time: lastPt.t,
      open: traded.length ? traded[0].last : null,
      high: prices.length ? Math.max(...prices) : null,
      low: prices.length ? Math.min(...prices) : null,
      last: lastPt.last,
      final: lastPt.final || lastPt.last,
      yesterday,
      changePct: pct,
      value: lastPt.value || 0,
      realBuyVol: num(r.real_buy_volume), realSellVol: num(r.real_sell_volume),
      realBuyVal: num(r.real_buy_value), realSellVal: num(r.real_sell_value),
      realBuyCount: num(r.real_buy_count), realSellCount: num(r.real_sell_count),
      snapshots: s.points.length
    });
  }
  return out;
}

async function getMarketSnapshots() {
  const json = await getJson(`${API}/industry/market-snapshots`);
  return { date: json.date, symbols: summarizeSnapshots(json.data || []) };
}

function parseSymbolData(d) {
  if (!d) return null;
  return {
    symbol: faKey(d.name), insCode: String(d.instance_code || ''), sector: d.industry, sectorCode: String(d.industry_code || ''),
    open: num(d.first_price), high: num(d.highest_price), low: num(d.lowest_price),
    last: num(d.close_price), final: num(d.final_price), yesterday: num(d.yesterday_price),
    vol: num(d.trade_volume), value: num(d.trade_value), count: num(d.trade_number),
    realBuyVol: num(d.real_buy_volume), realSellVol: num(d.real_sell_volume), legalBuyVol: num(d.co_buy_volume), legalSellVol: num(d.co_sell_volume),
    realBuyVal: num(d.real_buy_value), realSellVal: num(d.real_sell_value), legalBuyVal: num(d.co_buy_value), legalSellVal: num(d.co_sell_value),
    realBuyCount: num(d.real_buy_count), realSellCount: num(d.real_sell_count), legalBuyCount: num(d.co_buy_count), legalSellCount: num(d.co_sell_count),
    eps: num(d.eps), pe: num(d['P:E']), freeFloat: num(d.free_float), shares: num(d.all_stocks),
    tradeDate: d.last_trade_date, state: d.state
  };
}

async function getSymbolData(symbol) {
  const json = await getJson(`${API}/symbol-data?symbol=${encodeURIComponent(symbol)}`, { timeoutMs: 30000 });
  return parseSymbolData(json && json.data);
}

async function getMarketIndices() {
  const json = await getJson(`${API}/market-indices`, { timeoutMs: 30000 });
  const b = (json && json.data && json.data.bourse) || {};
  return { state: b.state, index: num(b.index), changePct: num(b.index_change_percent), equalWeight: num(b.index_h), equalChangePct: num(b.index_h_change_percent), tradeValue: b.trade_value };
}

module.exports = { API, faKey, num, getJson, summarizeSnapshots, getMarketSnapshots, parseSymbolData, getSymbolData, getMarketIndices };
