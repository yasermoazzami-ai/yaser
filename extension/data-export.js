'use strict';
/* Data export page: pulls price history, real/legal flow, instrument info and Codal
   letters from the user's own (Iranian) connection and saves one gzipped JSON file
   for offline technical + fundamental analysis (see analysis/tse-report.js). */

const core = globalThis.RadarExportCore;
const API = 'https://cdn.tsetmc.com/api';
const INDEX_CODES = { tedpix: '32097828799138957', equalWeight: '67130298613737946' };
const CODAL_MAX_SYMBOLS = 60;
const CODAL_MONTHLY_TYPE = 58;   // گزارش فعالیت ماهانه (ن-۳۰)
const CODAL_STATEMENT_TYPE = 6;  // اطلاعات و صورت‌های مالی میان‌دوره‌ای / سالانه

const $ = id => document.getElementById(id);
let stopRequested = false;
let lastBlob = null;
let lastName = '';

function log(msg, isErr) {
  const line = document.createElement('div');
  if (isErr) line.className = 'err';
  line.textContent = msg;
  $('log').prepend(line);
}
function setStatus(msg) { $('status').textContent = msg; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json,text/html,*/*' } });
    const text = await res.text();
    if (!res.ok || !text.trim()) throw new Error(`HTTP ${res.status}`);
    return text;
  } finally { clearTimeout(timer); }
}

async function fetchJson(url, { retries = 2, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (stopRequested) throw new Error('stopped');
    try { return JSON.parse(await fetchText(url, timeoutMs)); }
    catch (e) { lastErr = e; await sleep(600 * (i + 1)); }
  }
  throw lastErr;
}

function marketWatchUrl(market) {
  const q = new URLSearchParams();
  q.set('market', String(market));
  q.set('industrialGroup', '');
  for (let i = 0; i < 9; i++) q.append(`paperTypes[${i}]`, String(i + 1));
  q.set('showTraded', 'false');
  q.set('withBestLimits', 'false');
  q.set('hEven', '0');
  q.set('RefID', '0');
  return `${API}/ClosingPrice/GetMarketWatch?${q}`;
}

async function loadUniverse() {
  const jsons = [];
  for (const market of [0, 1]) {
    try { jsons.push(await fetchJson(marketWatchUrl(market))); }
    catch (e) { log(`دیدبان بازار ${market} دریافت نشد: ${e.message}`, true); }
  }
  return core.parseUniverse(jsons);
}

async function searchInstrument(symbol) {
  const json = await fetchJson(`${API}/Instrument/GetInstrumentSearch/${encodeURIComponent(symbol)}`);
  const arrays = core.findRowArrays(json, o => core.pick(o, ['insCode']) !== undefined && core.pick(o, ['lVal18AFC']) !== undefined);
  for (const arr of arrays) for (const o of arr) {
    if (core.normalizeSymbol(o.lVal18AFC) === symbol && (o.lastDate === undefined || o.lastDate > 0)) {
      return { insCode: String(o.insCode), symbol: String(o.lVal18AFC).trim(), name: String(o.lVal30 || '').trim(), value: 0, equity: true };
    }
  }
  return null;
}

async function resolveSelection(universe) {
  const mode = document.querySelector('input[name=mode]:checked').value;
  if (mode === 'all') return universe.filter(r => r.equity);
  if (mode === 'market') {
    const topN = Math.max(20, Number($('topN').value) || 300);
    return universe.filter(r => r.equity && r.value > 0).slice(0, topN);
  }
  const wanted = core.parseWatchlist($('symbols').value);
  const bySymbol = new Map();
  for (const r of universe) {
    const key = core.normalizeSymbol(r.symbol);
    if (!bySymbol.has(key) || r.value > bySymbol.get(key).value) bySymbol.set(key, r);
  }
  const out = [];
  for (const s of wanted) {
    let row = bySymbol.get(s);
    if (!row) {
      try { row = await searchInstrument(s); } catch (e) { /* reported below */ }
    }
    if (row) out.push(row); else log(`نماد «${s}» پیدا نشد.`, true);
  }
  return out;
}

async function loadIndex(days) {
  const out = {};
  for (const [key, code] of Object.entries(INDEX_CODES)) {
    try {
      const json = await fetchJson(`${API}/Index/GetIndexB2History/${code}`);
      out[key] = { insCode: code, columns: core.INDEX_COLUMNS, rows: core.compactIndex(json, days) };
      log(`شاخص ${key}: ${out[key].rows.length} روز`);
    } catch (e) {
      out[key] = { insCode: code, columns: core.INDEX_COLUMNS, rows: [], error: e.message };
      log(`شاخص ${key} دریافت نشد: ${e.message}`, true);
    }
  }
  return out;
}

function codalSearchUrl(symbol, letterType) {
  const q = new URLSearchParams({
    Symbol: symbol, LetterType: String(letterType), Audit: 'true', AuditorRef: '-1', Category: '-1',
    Childs: 'true', CompanyState: '-1', CompanyType: '-1', Consolidatable: 'true', IsNotAudited: 'false',
    Length: '-1', Mains: 'true', NotAudited: 'true', NotConsolidatable: 'true', PageNumber: '1',
    Publisher: 'false', TracingNo: '-1', search: 'true'
  });
  return `https://search.codal.ir/api/search/v2/q?${q}`;
}

function absoluteCodalUrl(u, host) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${host}${u.startsWith('/') ? '' : '/'}${u}`;
}

async function loadCodal(symbol) {
  const out = { monthly: [], statements: [], monthlyTables: [], errors: [] };
  try { out.monthly = core.compactLetters(await fetchJson(codalSearchUrl(symbol, CODAL_MONTHLY_TYPE)), 8); }
  catch (e) { out.errors.push(`monthly: ${e.message}`); }
  try { out.statements = core.compactLetters(await fetchJson(codalSearchUrl(symbol, CODAL_STATEMENT_TYPE)), 6); }
  catch (e) { out.errors.push(`statements: ${e.message}`); }
  for (const letter of out.monthly.filter(l => l.excelUrl).slice(0, 2)) {
    try {
      const html = await fetchText(absoluteCodalUrl(letter.excelUrl, 'excel.codal.ir'), 30000);
      out.monthlyTables.push({ title: letter.title, publishDate: letter.publishDate, text: core.tablesToText(html) });
    } catch (e) { out.errors.push(`excel ${letter.tracingNo}: ${e.message}`); }
  }
  return out;
}

async function loadSymbol(row, opts) {
  const item = { insCode: row.insCode, symbol: row.symbol, name: row.name, errors: [] };
  try {
    const json = await fetchJson(`${API}/Instrument/GetInstrumentInfo/${row.insCode}`);
    item.info = core.compactInfo(json);
  } catch (e) { item.errors.push(`info: ${e.message}`); }
  // In market-wide modes, ETFs (sector 68) are not stocks: skip their history to save time.
  if (opts.skipFunds && item.info && item.info.sectorCode === core.FUND_SECTOR) {
    item.skipped = 'fund';
    return item;
  }
  try {
    const json = await fetchJson(`${API}/ClosingPrice/GetClosingPriceDailyList/${row.insCode}/0`);
    item.daily = { columns: core.DAILY_COLUMNS, rows: core.compactDaily(json, opts.days) };
    if (!item.daily.rows.length) item.daily.rawSample = JSON.stringify(json).slice(0, 600);
  } catch (e) { item.errors.push(`daily: ${e.message}`); }
  if (opts.withClient) {
    try {
      const json = await fetchJson(`${API}/ClientType/GetClientTypeHistory/${row.insCode}`);
      item.client = { columns: core.CLIENT_COLUMNS, rows: core.compactClient(json, opts.days) };
      if (!item.client.rows.length) item.client.rawSample = JSON.stringify(json).slice(0, 600);
    } catch (e) { item.errors.push(`client: ${e.message}`); }
  }
  if (opts.withCodal) item.codal = await loadCodal(row.symbol);
  return item;
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (!stopRequested && next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results.filter(Boolean);
}

async function gzip(text) {
  if (typeof CompressionStream !== 'function') return { blob: new Blob([text], { type: 'application/json' }), ext: 'json' };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return { blob: await new Response(stream).blob(), ext: 'json.gz' };
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function start() {
  stopRequested = false;
  lastBlob = null;
  $('startBtn').disabled = true; $('stopBtn').disabled = false; $('downloadBtn').disabled = true;
  $('log').textContent = '';
  const opts = {
    days: Math.max(60, Number($('days').value) || 320),
    withClient: $('withClient').checked,
    withCodal: $('withCodal').checked,
    concurrency: Math.min(8, Math.max(1, Number($('concurrency').value) || 4)),
    skipFunds: document.querySelector('input[name=mode]:checked').value !== 'watchlist'
  };
  try {
    setStatus('دریافت دیدبان بازار...');
    const universe = await loadUniverse();
    log(`دیدبان: ${universe.length} نماد`);
    const selection = await resolveSelection(universe);
    if (!selection.length) throw new Error('هیچ نمادی برای دریافت انتخاب نشد.');
    if (opts.withCodal && selection.length > CODAL_MAX_SYMBOLS) {
      opts.withCodal = false;
      log(`کدال برای بیش از ${CODAL_MAX_SYMBOLS} نماد غیرفعال شد.`);
    }
    setStatus('دریافت تاریخچه شاخص...');
    const index = await loadIndex(opts.days);

    let done = 0;
    const symbols = await runPool(selection, opts.concurrency, async row => {
      const item = await loadSymbol(row, opts);
      done++;
      $('progress').value = Math.round(done / selection.length * 100);
      setStatus(`${done} از ${selection.length}: ${row.symbol}`);
      if (item.errors.length) log(`${row.symbol}: ${item.errors.join(' | ')}`, true);
      return item;
    });

    const payload = {
      schema: core.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      source: 'TSETMC Stocks Radar Pro data export',
      units: { price: 'rial', value: 'rial' },
      options: opts,
      stopped: stopRequested,
      universe: universe.map(r => ({ insCode: r.insCode, symbol: r.symbol, value: r.value, equity: r.equity })),
      index,
      symbols
    };
    const { blob, ext } = await gzip(JSON.stringify(payload));
    lastBlob = blob;
    lastName = `tse-export-${stamp()}.${ext}`;
    $('downloadBtn').disabled = false;
    const funds = symbols.filter(s => s.skipped === 'fund').length;
    const failed = symbols.filter(s => !s.skipped && (!s.daily || !s.daily.rows.length)).length;
    setStatus(`تمام شد${stopRequested ? ' (متوقف‌شده)' : ''}: ${symbols.length - funds} سهم (${funds} صندوق کنار گذاشته شد)، ${failed} بدون تاریخچه قیمت. حجم فایل ${(blob.size / 1024 / 1024).toFixed(2)} مگابایت.`);
    download();
  } catch (e) {
    setStatus(`خطا: ${e.message}`);
    log(String(e.stack || e), true);
  } finally {
    $('startBtn').disabled = false; $('stopBtn').disabled = true;
  }
}

function download() {
  if (!lastBlob) return;
  const url = URL.createObjectURL(lastBlob);
  const a = document.createElement('a');
  a.href = url; a.download = lastName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('startBtn').addEventListener('click', start);
$('stopBtn').addEventListener('click', () => { stopRequested = true; setStatus('در حال توقف...'); });
$('downloadBtn').addEventListener('click', download);
