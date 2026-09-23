(function attachExportCore(root, factory) {
  const api = factory();
  root.RadarExportCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createExportCore() {
  'use strict';

  // Pure helpers for the data-export page: they turn raw TSETMC / Codal JSON into
  // compact column arrays so a full-market export stays small enough to upload.
  // Field aliases follow the same TSETMC CDN schema the dashboard reads (see SOURCES.md).

  const SCHEMA_VERSION = 1;

  const DAILY_COLUMNS = ['d', 'open', 'high', 'low', 'close', 'last', 'yesterday', 'vol', 'value', 'count'];
  const CLIENT_COLUMNS = ['d', 'buyIVol', 'sellIVol', 'buyNVol', 'sellNVol', 'buyICount', 'sellICount', 'buyNCount', 'sellNCount', 'buyIVal', 'sellIVal', 'buyNVal', 'sellNVal'];
  const INDEX_COLUMNS = ['d', 'close', 'high', 'low'];

  const NON_EQUITY_NAME = /صندوق|اوراق|اختیار|سلف|تسهیلات|مرابحه|اجاره|منفعت|گواهی|مشارکت|خزانه|سپرده|آتی|تبعی/;

  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }

  function pick(o, keys) {
    if (!o || typeof o !== 'object') return undefined;
    for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    return undefined;
  }

  function pickNum(o, keys) {
    const v = num(pick(o, keys));
    return Number.isFinite(v) ? v : null;
  }

  // Walks any JSON shape and returns every array whose objects satisfy `isRow`.
  function findRowArrays(rootObj, isRow) {
    const out = [];
    const seen = new Set();
    (function walk(x) {
      if (!x || typeof x !== 'object' || seen.has(x)) return;
      seen.add(x);
      if (Array.isArray(x)) {
        if (x.some(v => v && typeof v === 'object' && !Array.isArray(v) && isRow(v))) out.push(x);
        x.forEach(walk);
      } else Object.values(x).forEach(walk);
    })(rootObj);
    return out;
  }

  function largest(arrays) {
    return arrays.reduce((best, a) => (a.length > best.length ? a : best), []);
  }

  function dateKey(v) {
    const s = String(v ?? '').replace(/[^0-9]/g, '');
    return s.length >= 8 ? Number(s.slice(0, 8)) : null;
  }

  function sortTrim(rows, maxDays) {
    const byDay = new Map();
    for (const r of rows) if (r && r[0]) byDay.set(r[0], r);
    const sorted = [...byDay.values()].sort((a, b) => a[0] - b[0]);
    return maxDays > 0 ? sorted.slice(-maxDays) : sorted;
  }

  const DAILY_DATE = ['dEven', 'DEven', 'date', 'dateEven'];
  function compactDaily(json, maxDays = 0) {
    const arr = largest(findRowArrays(json, o => pick(o, DAILY_DATE) !== undefined && pick(o, ['pClosing', 'PClosing', 'pDrCotVal', 'qTotCap']) !== undefined));
    const rows = arr.map(o => {
      const d = dateKey(pick(o, DAILY_DATE));
      const close = pickNum(o, ['pClosing', 'PClosing', 'close']);
      if (!d || !(close > 0)) return null;
      const vol = pickNum(o, ['qTotTran5J', 'QTotTran5J', 'volume']);
      if (!(vol > 0)) return null; // non-trading days carry a stale price and would flatten indicators
      return [
        d,
        pickNum(o, ['priceFirst', 'PriceFirst', 'open']),
        pickNum(o, ['priceMax', 'PriceMax', 'high']),
        pickNum(o, ['priceMin', 'PriceMin', 'low']),
        close,
        pickNum(o, ['pDrCotVal', 'PDrCotVal', 'last']),
        pickNum(o, ['priceYesterday', 'PriceYesterday', 'yesterday']),
        vol,
        pickNum(o, ['qTotCap', 'QTotCap', 'value']),
        pickNum(o, ['zTotTran', 'ZTotTran', 'count'])
      ];
    });
    return sortTrim(rows, maxDays);
  }

  const CLIENT_DATE = ['recDate', 'RecDate', 'dEven', 'date'];
  function compactClient(json, maxDays = 0) {
    const arr = largest(findRowArrays(json, o => pick(o, CLIENT_DATE) !== undefined && pick(o, ['buy_I_Volume', 'Buy_I_Volume', 'buy_CountI', 'Buy_CountI']) !== undefined));
    const rows = arr.map(o => {
      const d = dateKey(pick(o, CLIENT_DATE));
      if (!d) return null;
      return [
        d,
        pickNum(o, ['buy_I_Volume', 'Buy_I_Volume']),
        pickNum(o, ['sell_I_Volume', 'Sell_I_Volume']),
        pickNum(o, ['buy_N_Volume', 'Buy_N_Volume']),
        pickNum(o, ['sell_N_Volume', 'Sell_N_Volume']),
        pickNum(o, ['buy_CountI', 'Buy_CountI', 'buy_I_Count']),
        pickNum(o, ['sell_CountI', 'Sell_CountI', 'sell_I_Count']),
        pickNum(o, ['buy_CountN', 'Buy_CountN', 'buy_N_Count']),
        pickNum(o, ['sell_CountN', 'Sell_CountN', 'sell_N_Count']),
        pickNum(o, ['buy_I_Value', 'Buy_I_Value']),
        pickNum(o, ['sell_I_Value', 'Sell_I_Value']),
        pickNum(o, ['buy_N_Value', 'Buy_N_Value']),
        pickNum(o, ['sell_N_Value', 'Sell_N_Value'])
      ];
    });
    return sortTrim(rows, maxDays);
  }

  function compactIndex(json, maxDays = 0) {
    const arr = largest(findRowArrays(json, o => pick(o, DAILY_DATE) !== undefined && pick(o, ['xNivInuClMresIbs', 'close', 'indexValue']) !== undefined));
    const rows = arr.map(o => {
      const d = dateKey(pick(o, DAILY_DATE));
      const close = pickNum(o, ['xNivInuClMresIbs', 'close', 'indexValue']);
      if (!d || !(close > 0)) return null;
      return [d, close, pickNum(o, ['xNivInuPhMresIbs', 'high']), pickNum(o, ['xNivInuPbMresIbs', 'low'])];
    });
    return sortTrim(rows, maxDays);
  }

  function compactInfo(json) {
    const info = (json && (json.instrumentInfo || json.InstrumentInfo)) || json || {};
    const eps = info.eps || info.EPS || {};
    const sector = info.sector || info.Sector || {};
    return {
      symbol: String(pick(info, ['lVal18AFC', 'LVal18AFC', 'symbol']) || '').trim(),
      name: String(pick(info, ['lVal30', 'LVal30', 'name']) || '').trim(),
      sectorCode: String(pick(sector, ['cSecVal', 'CSecVal']) || pick(info, ['cSecVal']) || '').trim(),
      sectorName: String(pick(sector, ['lSecVal', 'LSecVal']) || '').trim(),
      epsTtm: pickNum(eps, ['epsValue', 'EpsValue']),
      epsForecast: pickNum(eps, ['estimatedEPS', 'EstimatedEPS']),
      sectorPE: pickNum(eps, ['sectorPE', 'SectorPE']),
      psr: pickNum(eps, ['psr', 'PSR']),
      shares: pickNum(info, ['zTitad', 'ZTitad']),
      baseVol: pickNum(info, ['baseVol', 'BaseVol']),
      avgVol3m: pickNum(info, ['qTotTran5JAvg', 'QTotTran5JAvg']),
      floatPct: pickNum(info, ['kAjCapValCpsIdx', 'freeFloat']),
      flow: pickNum(info, ['flow', 'Flow']),
      yearHigh: pickNum(info, ['maxYear', 'MaxYear']),
      yearLow: pickNum(info, ['minYear', 'MinYear'])
    };
  }

  function isEquityLike(symbol, name) {
    const s = String(symbol || '').trim();
    if (!s || /[0-9۰-۹]/.test(s)) return false;
    if (s.length > 2 && s.endsWith('ح')) return false; // subscription rights (حق تقدم)
    return !NON_EQUITY_NAME.test(String(name || ''));
  }

  // Market-watch rows → de-duplicated universe sorted by traded value.
  function parseUniverse(marketJsons) {
    const map = new Map();
    for (const json of [].concat(marketJsons || [])) {
      const arrays = findRowArrays(json, o => pick(o, ['insCode', 'InsCode']) !== undefined && pick(o, ['lva', 'lVal18AFC', 'l18']) !== undefined);
      for (const arr of arrays) for (const o of arr) {
        const insCode = String(pick(o, ['insCode', 'InsCode']) || '').trim();
        const symbol = String(pick(o, ['lva', 'lVal18AFC', 'l18']) || '').trim();
        if (!/^\d{6,}$/.test(insCode) || !symbol) continue;
        const name = String(pick(o, ['lvc', 'lVal30', 'l30']) || '').trim();
        const row = {
          insCode, symbol, name,
          value: pickNum(o, ['qtc', 'qTotCap']) || 0,
          close: pickNum(o, ['pcl', 'pClosing', 'pc']),
          eps: pickNum(o, ['eps', 'EPS']),
          equity: isEquityLike(symbol, name)
        };
        const prev = map.get(insCode);
        if (!prev || row.value > prev.value) map.set(insCode, row);
      }
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }

  function normalizeSymbol(s) {
    return String(s || '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[\u200c\s]/g, '').trim();
  }

  function parseWatchlist(text) {
    return [...new Set(String(text || '').split(/[\s,،؛;]+/).map(normalizeSymbol).filter(Boolean))];
  }

  // Codal letter search → the few fields the analyser needs.
  function compactLetters(json, max = 8) {
    const letters = (json && (json.Letters || json.letters)) || [];
    return letters.slice(0, max).map(l => ({
      tracingNo: pick(l, ['TracingNo']),
      title: String(pick(l, ['Title']) || ''),
      letterCode: String(pick(l, ['LetterCode']) || ''),
      publishDate: String(pick(l, ['PublishDateTime', 'SentDateTime']) || ''),
      url: String(pick(l, ['Url']) || ''),
      excelUrl: String(pick(l, ['ExcelUrl']) || '')
    }));
  }

  // Codal "Excel" exports are HTML tables; keep only table text so the export stays small.
  function tablesToText(html, maxChars = 60000) {
    const src = String(html || '');
    const tables = src.match(/<table[\s\S]*?<\/table>/gi) || [];
    const out = tables.map(t => t
      .replace(/<\/(td|th)>/gi, '\t')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \u00a0]+/g, ' ')
      .replace(/ ?\t ?/g, '\t')
      .replace(/\t+\n/g, '\n')
      .replace(/\n[ \t]*\n+/g, '\n')
      .trim()).join('\n---\n');
    return out.slice(0, maxChars);
  }

  return {
    SCHEMA_VERSION, DAILY_COLUMNS, CLIENT_COLUMNS, INDEX_COLUMNS,
    num, pick, findRowArrays, dateKey,
    compactDaily, compactClient, compactIndex, compactInfo,
    isEquityLike, parseUniverse, normalizeSymbol, parseWatchlist,
    compactLetters, tablesToText
  };
});
