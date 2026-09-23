const APP_VERSION = '8.16.0-smart-scan'; // base: 7.3.0-main-radar-trends
const $ = id => document.getElementById(id);
const $$ = sel => [...document.querySelectorAll(sel)];

// نسخه بهینه اجرای همزمان: فقط سهام عادی بورس/فرابورس + صندوق‌های سهامی/ETF؛ طلا، نقره، درآمد ثابت، اوراق، اختیار و کالا حذف شدند.
const MARKET_TEXT_URLS = [
  // اولویت با MarketWatchInit است چون کد گروه صنعت TSE در ستون p18 آن قابل اتکاتر است.
  'https://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0',
  'http://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0',
  'https://old.tsetmc.com/tsev2/data/MarketWatchPlus.aspx?h=0&r=0',
  'http://old.tsetmc.com/tsev2/data/MarketWatchPlus.aspx?h=0&r=0'
];
const MARKET_JSON_URLS = [
  'https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch?market=0&industrialGroup=',
  'https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch?market=1&industrialGroup='
];
const CLIENT_URLS = [
  // JSON first: named fields remove all ambiguity in count/volume column order.
  'https://cdn.tsetmc.com/api/ClientType/GetClientTypeAll',
  'https://old.tsetmc.com/tsev2/data/ClientTypeAll.aspx',
  'http://old.tsetmc.com/tsev2/data/ClientTypeAll.aspx'
];
const BIG_AVG_ORDER_B = 3; // compatibility label only; formula lives in formula-engine.js
const MOJ3_BIG_MIN_ORDER_B = globalThis.RadarFormulaEngine?.LARGE_ORDER_MIN_B ?? 0.5;
const MOJ3_BIG_REF_ORDER_B = 3;
const MOJ3_BIG_SIDE_SCALE = 1;
const MOJ3_TOMAN_UNIT_FIX = 1; // no unit conversion here; UI converts billion-rial -> toman exactly once
const MOJ3_BIG_MAX_WEIGHT = 1;
const DEFAULT_MONITOR_INTERVAL_MS = 2000;
const BIG_MONEY_SNAPSHOT_MS = globalThis.RadarFormulaEngine?.LARGE_FLOW_SNAPSHOT_MS || 2000;
const BIG_MONEY_THRESHOLD_B = globalThis.RadarFormulaEngine?.LARGE_ORDER_MIN_B || 1; // 1B rial = 100M toman
const MIN_MONITOR_INTERVAL_MS = 2000;
const MAX_MONITOR_INTERVAL_MS = 30000;
const ALERT_BIG_DELTA_B = globalThis.RadarAlertPolicy?.BIG_INSTANT_THRESHOLD_B || 20; // ۲۰ میلیارد ریال = ۲ میلیارد تومان
const MAX_ALERTS = 160;
const DAILY_VALUE_LIMIT = 500; // حداکثر تعداد نماد برای محاسبه میانگین ۵/۲۰ روزه ارزش معاملات
const CLIENT_CACHE_MS = 0; // دریافت تازه حقیقی/حقوقی در هر بروزرسانی برای جلوگیری از ثابت ماندن پول حقیقی
const AUTO_START_DELAY_MS = 1000; // تأخیر شروع برای جلوگیری از همزمانی دو افزونه
const STORAGE_KEY = 'tsetmcStocksRadar_v720_symbol_trends_state';

let state = { appVersion: APP_VERSION, rows: [], clientRows: 0, debug: [], lastUpdated: null, source: '', history: [], selectedGroup: 'all', alerts: [], monitorStartedAt: null, dailyValue: null, dataQuality: {}, monitorIntervalMs: DEFAULT_MONITOR_INTERVAL_MS, hotMoneyHistory: null, symbolBigTrend: {}, bigMoneyFlow: { date:null, symbols:{} }, sessionDate: null, sessionTradingObserved: false, marketPhase: 'unknown' };
let autoTimer = null;
let isRefreshing = false;
let cachedClientMap = null;
let cachedClientAt = 0;

window.addEventListener('DOMContentLoaded', async () => {
  bind();
  await loadCache();
  renderAll();
  startAuto(true);
});

function bind(){
  const on = (id, ev, fn) => { const e=$(id); if(e) e.addEventListener(ev, fn); };
  on('refreshBtn','click', () => refresh());
  on('dailyValueBtn','click', () => ensureDailyValueHistory(true));
  on('autoBtn','click', startAuto);
  on('stopAutoBtn','click', stopAuto);
  on('intervalSelect','change', onIntervalChange);
  on('resetHistoryBtn','click', async () => { state.history = []; state.symbolBigTrend = {}; await saveCache(); renderAll(); setStatus('روندها پاک شدند.'); });
  on('clearAlertsBtn','click', async () => { state.alerts = []; await saveCache(); renderAlerts(); setStatus('رخدادها پاک شدند.'); });
  on('fullscreenBtn','click', () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(()=>{}));
  on('clearBtn','click', async () => { await chrome.storage.local.remove([STORAGE_KEY]); cachedClientMap = null; cachedClientAt = 0; state = { appVersion: APP_VERSION, rows: [], clientRows: 0, debug: [], lastUpdated: null, source: '', history: [], selectedGroup: 'all', alerts: [], monitorStartedAt: null, dailyValue: null, dataQuality: {}, monitorIntervalMs: DEFAULT_MONITOR_INTERVAL_MS, hotMoneyHistory: null, symbolBigTrend: {}, bigMoneyFlow: { date:null, symbols:{} }, sessionDate: null, sessionTradingObserved: false, marketPhase: 'unknown' }; renderAll(); setStatus('کش پاک شد. به‌روزرسانی مستقیم را بزن.'); });
  on('copyDebugBtn','click', copyDebug);
  ['searchInput','bigSearchInput','battleSearchInput'].forEach(id => on(id,'input', renderAllTables));
  on('globalSearchInput','input', renderAllTables);
  on('clearSearchBtn','click', () => { const e=$('globalSearchInput'); if(e){ e.value=''; renderAllTables(); setStatus('جستجو پاک شد.'); } });
  on('globalSearchInput','keydown', e => { if(e.key === 'Enter') activate('symbols'); });
  ['sortSelect','bigGroupSelect','battleGroupSelect','bigModeSelect','battleModeSelect'].forEach(id => on(id,'change', renderAllTables));
  on('groupSelect','change', () => { state.selectedGroup = $('groupSelect')?.value || 'all'; renderAllTables(); renderGroups(); });
  ['trendGroupSelect'].forEach(id => on(id,'change', () => { renderCharts(); renderDailyValueStatus(); }));
  $$('.tab').forEach(b => b.onclick = () => activate(b.dataset.page));
  document.addEventListener('click', handleGroupClick);
  addEventListener('resize', () => { renderCharts(); });
}

function getMonitorIntervalMs(){
  const v = Number(state.monitorIntervalMs || DEFAULT_MONITOR_INTERVAL_MS);
  if(!Number.isFinite(v)) return DEFAULT_MONITOR_INTERVAL_MS;
  return Math.min(MAX_MONITOR_INTERVAL_MS, Math.max(MIN_MONITOR_INTERVAL_MS, v));
}
function intervalLabel(ms){ return ms < 1000 ? `${ms} میلی‌ثانیه` : `${Math.round(ms/1000)} ثانیه`; }
function syncIntervalSelect(){
  const e = $('intervalSelect');
  if(e) e.value = String(getMonitorIntervalMs());
}
async function onIntervalChange(){
  const e = $('intervalSelect');
  const next = Math.min(MAX_MONITOR_INTERVAL_MS, Math.max(MIN_MONITOR_INTERVAL_MS, Number(e?.value || DEFAULT_MONITOR_INTERVAL_MS)));
  state.monitorIntervalMs = next;
  await saveCache();
  const wasOn = !!autoTimer;
  if(wasOn){ stopAuto(true); startAuto(false); }
  else setMonitorBadge(false);
  setStatus(`سرعت پایش: ${intervalLabel(next)}`);
}

function startAuto(silent=false){
  if(autoTimer) return setStatus('پایش خودکار از قبل فعال است.');
  syncIntervalSelect();
  state.monitorStartedAt = state.monitorStartedAt || Date.now();
  setMonitorBadge(true);
  const ms = getMonitorIntervalMs();
  if(!silent) setStatus(`پایش خودکار فعال شد: ${intervalLabel(ms)}`);
  setTimeout(() => refresh({ fromAuto:true }), silent ? AUTO_START_DELAY_MS : 0);
  autoTimer = setInterval(() => refresh({ fromAuto:true }), ms);
}
function stopAuto(silent=false){
  if(autoTimer){ clearInterval(autoTimer); autoTimer = null; setMonitorBadge(false); if(!silent) setStatus('پایش خودکار متوقف شد.'); }
  else if(!silent) setStatus('پایش خودکار فعال نبود.');
}
function setMonitorBadge(on){
  const e = $('monitorBadge'); if(!e) return;
  const sess = globalThis.RadarMarketSession?.current?.();
  const active = !!(sess && globalThis.RadarMarketSession?.canGenerateAlerts?.(sess));
  if(on && !active){
    e.textContent = `پایش آماده | ${globalThis.RadarMarketSession?.phaseLabel?.(sess?.phase) || 'بازار بسته'}؛ شمارنده متوقف`;
    e.className = 'monitorBadge off';
    return;
  }
  e.textContent = on ? `پایش توربو فعال | هر ${intervalLabel(getMonitorIntervalMs())}` : 'پایش خودکار متوقف';
  e.className = on ? 'monitorBadge on' : 'monitorBadge off';
}
function activate(page){ $$('.tab').forEach(b=>b.classList.toggle('active', b.dataset.page===page)); $$('.page').forEach(p=>p.classList.toggle('active', p.id===page)); if(['charts','trend','groups'].includes(page)) setTimeout(renderCharts,80); }
async function loadCache(){
  // v7.1 uses a fresh key so stale v7.0 rows/alerts cannot leak into the new Tehran session.
  const c = await chrome.storage.local.get([STORAGE_KEY]);
  if(c[STORAGE_KEY]){
    const saved = c[STORAGE_KEY];
    const validAlerts = (saved.alerts || []).filter(a => globalThis.RadarAlertPolicy?.qualifies(a));
    state = { ...state, ...saved, appVersion: APP_VERSION, selectedGroup: saved.selectedGroup || 'all', history: saved.history || [], alerts: validAlerts, dailyValue: saved.dailyValue || null, dataQuality: saved.dataQuality || {}, monitorIntervalMs: DEFAULT_MONITOR_INTERVAL_MS, hotMoneyHistory: saved.hotMoneyHistory || null, symbolBigTrend: saved.symbolBigTrend || {}, bigMoneyFlow: saved.bigMoneyFlow && typeof saved.bigMoneyFlow === 'object' ? saved.bigMoneyFlow : { date:null, symbols:{} } };
  }
  syncIntervalSelect();
  renderAll();
}
async function saveCache(){ await chrome.storage.local.set({ [STORAGE_KEY]: state }); }
function setStatus(msg,bad=false){ const e=$('statusBox'); e.textContent=msg; e.style.borderColor=bad?'rgba(239,68,68,.6)':'var(--line)'; e.style.color=bad?'#fecaca':'var(--muted)'; }

function v83FailureMessage(err){
  const failed=(state.debug||[]).filter(x=>x && (x.stage==='fetch-failed' || String(x.stage||'').includes('error'))).slice(-4);
  const bits=failed.map(x=>`${x.url||x.stage}: ${x.message||'خطا'}`);
  const base=(err && (err.message||String(err))) || 'دریافت داده ناموفق بود';
  return bits.length ? `دریافت داده ناموفق: ${base} | ${bits.join(' | ')}` : `دریافت داده ناموفق: ${base}`;
}

async function refresh(opts={}){
  if(isRefreshing){
    if(!opts.fromAuto) setStatus('یک دریافت هنوز در حال اجراست؛ چند لحظه بعد دوباره تلاش کن.');
    return;
  }
  isRefreshing = true;
  const prevRows = (state.rows && state.lastUpdated && (Date.now() - state.lastUpdated < 10*60*1000)) ? state.rows : [];
  state.debug = [];
  setStatus(opts.fromAuto ? 'پایش خودکار فعال است...' : 'در حال دریافت داده...', false);
  $('refreshBtn').disabled = true;
  try{
    const market = await fetchMarket();
    const clients = await fetchClients();
    const newRows = buildRows(market, clients);
    state.dataQuality = assessDataQuality(newRows, clients, market);
    const newAlerts = detectInstantAlerts(prevRows, newRows);
    state.rows = newRows;
    state.clientRows = clients.size;
    state.lastUpdated = Date.now();
    if(newAlerts.length) addAlerts(newAlerts);
    addSnapshot(state.rows);
    await saveCache();
    setStatus(`به‌روزرسانی شد: ${fa(state.rows.length)} نماد | ${new Date(state.lastUpdated).toLocaleTimeString('fa-IR')}`);
  }catch(e){
    state.debug.push({ stage:'final-error', message:e.message || String(e) });
    setStatus(v83FailureMessage(e), true);
  }finally{
    isRefreshing = false;
    const rb = $('refreshBtn'); if(rb) rb.disabled = false;
    renderAll();
  }
}

function detectInstantAlerts(prevRows, newRows){
  if(!prevRows || prevRows.length < 20) return [];
  const prev = new Map(prevRows.map(x => [alertKey(x), x]));
  const now = Date.now();
  const alerts = [];
  for(const r of newRows || []){
    const p = prev.get(alertKey(r));
    if(!p) continue;
    const tapeFlow = r?._bigFlow2s;
    const flowDelta = globalThis.RadarFormulaEngine?.intervalFlowDelta(p, r);
    if(!flowDelta && !tapeFlow) continue;
    const dBig = Number(tapeFlow?.dBigB || 0);
    const dReal = Number(tapeFlow?.dRealB ?? flowDelta?.dRealB ?? 0);
    const dVal = Math.max(0, (r.valueB || 0) - (p.valueB || 0));
    const dVol = Math.max(0, (r.volume || 0) - (p.volume || 0));
    if(Math.abs(dBig) >= ALERT_BIG_DELTA_B){
      alerts.push(makeAlert(now, dBig>0?'bigBuy':'bigSell', r, dBig, dReal, dVal, dVol));
    }
  }
  return alerts.sort((a,b)=>Math.abs(b.amountB)-Math.abs(a.amountB)).slice(0,30);
}
function alertKey(x){ return String(x.numericInsCode || x.insCode || x.instrumentID || x.symbol || ''); }
function makeAlert(time, type, r, dBig, dReal, dVal, dVol){
  const isBuy = type === 'bigBuy' || type === 'realBuy';
  const isBig = type === 'bigBuy' || type === 'bigSell';
  const amountB = isBig ? dBig : dReal;
  const side = isBuy ? 'خرید' : 'فروش';
  const kind = isBig ? 'پول درشت' : 'پول حقیقی';
  return {
    id: `${time}-${alertKey(r)}-${type}-${Math.round(amountB*1000)}`, key: alertKey(r), time, type, symbol:r.symbol, fullName:r.fullName, group:r.assetGroup, boardUrl:r.boardUrl,
    title: `${side} ${kind} لحظه‌ای بالای ۲ میلیارد تومان ${r.symbol}`, amountB, dBig, dReal, dVal, dVol,
    cumulativeBigMoneyB: Number(r.bigMoneyB || 0),
    cumulativeBigBuyB: Number(r.bigBuyB || 0),
    cumulativeBigSellB: Number(r.bigSellB || 0),
    cumulativeRealMoneyB: Number(r.realMoneyB || 0),
    cumulativeValueB: Number(r.valueB || 0),
    buyPower: r.buyPower, sellPower: r.sellPower,
    lastPercent:r.lastPercent, closePercent:r.closePercent, gap:r.gap
  };
}
function addAlerts(list){
  const existing = new Set((state.alerts||[]).map(a=>a.id));
  const merged = [...list.filter(a=>!existing.has(a.id)), ...(state.alerts||[])]
    .filter(a => globalThis.RadarAlertPolicy?.qualifies(a));
  state.alerts = merged.slice(0, MAX_ALERTS);
}


async function fetchWithInfo(url, timeoutMs=20000){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  const start = performance.now();
  try{
    const res = await fetch(url, { cache:'no-store', credentials:'omit', signal:controller.signal, headers:{ Accept:'application/json,text/plain,text/csv,*/*' } });
    const text = await res.text();
    state.debug.push({ stage:'fetch', url:short(url), ok:res.ok, status:res.status, type:res.headers.get('content-type')||'', length:text.length, ms:Math.round(performance.now()-start), sample:text.slice(0,260).replace(/\s+/g,' ') });
    if(!res.ok) throw new Error(`${res.status} | ${text.slice(0,100)}`);
    if(!text.trim()) throw new Error('empty response');
    return text;
  }catch(e){
    state.debug.push({ stage:'fetch-failed', url:short(url), message:e.name==='AbortError'?'timeout':(e.message||String(e)) });
    throw e;
  }finally{ clearTimeout(timer); }
}

async function fetchMarket(){
  // نسخه بازبینی‌شده: قیمت/ارزش را از CDN می‌گیریم، ولی برای insCode و اتصال حقیقی/حقوقی
  // همزمان old.tsetmc را هم می‌گیریم و بر اساس ISIN/نماد merge می‌کنیم.
  const jsonRows = [];
  const textRows = [];
  for(const url of MARKET_JSON_URLS){
    try{
      const text = await fetchWithInfo(url, 6500);
      const rows = parseMarketJson(text, short(url));
      jsonRows.push(...rows);
      state.debug.push({ stage:'parse-json', url:short(url), rows:rows.length, totalJson:jsonRows.length });
    }catch(e){ state.debug.push({ stage:'json-error', url:short(url), message:e.name==='AbortError'?'timeout':(e.message||String(e)) }); }
  }
  for(const url of MARKET_TEXT_URLS){
    try{
      const text = await fetchWithInfo(url, 8500);
      const rows = parseMarketText(text, short(url));
      textRows.push(...rows);
      state.debug.push({ stage:'parse-text', url:short(url), rows:rows.length, totalText:textRows.length });
      if(textRows.length > 50) break;
    }catch(e){ state.debug.push({ stage:'text-error', url:short(url), message:e.name==='AbortError'?'timeout':(e.message||String(e)) }); }
  }
  const merged = mergeMarketRows(jsonRows, textRows);
  if(merged.length > 20){
    state.source = `${jsonRows.length?'cdn-json':''}${jsonRows.length&&textRows.length?'+':''}${textRows.length?'old-meta':''}` || 'market-merged';
    state.debug.push({ stage:'market-selected', source:state.source, jsonRows:jsonRows.length, textRows:textRows.length, mergedRows:merged.length, mode:'audited-merge' });
    return merged;
  }
  if(jsonRows.length){ state.source='cdn-json-only'; return dedupeMarketRows(jsonRows); }
  if(textRows.length){ state.source='old-text-only'; return dedupeMarketRows(textRows); }
  throw new Error('هیچ داده بازار قابل پردازش دریافت نشد');
}

function mergeMarketRows(jsonRows, textRows){
  const byNum = new Map(), byIsin = new Map(), bySym = new Map();
  for(const t of textRows){
    if(t.numericInsCode) byNum.set(String(t.numericInsCode), t);
    if(t.instrumentID) byIsin.set(String(t.instrumentID).toUpperCase(), t);
    if(t.symbol) bySym.set(compactKey(t.symbol), t);
  }
  const used = new Set();
  const out = [];
  for(const j of jsonRows){
    const match = (j.numericInsCode && byNum.get(String(j.numericInsCode))) ||
      (j.instrumentID && byIsin.get(String(j.instrumentID).toUpperCase())) ||
      (j.symbol && bySym.get(compactKey(j.symbol)));
    if(match){ used.add(match.rowKey || match.numericInsCode || match.instrumentID || compactKey(match.symbol)); }
    out.push(mergeJsonWithOldMeta(j, match));
  }
  for(const t of textRows){
    const k = t.rowKey || t.numericInsCode || t.instrumentID || compactKey(t.symbol);
    if(!used.has(k)) out.push(t);
  }
  return dedupeMarketRows(out);
}
function mergeJsonWithOldMeta(j, t){
  if(!t) return j;
  const m = { ...j };
  if(!m.numericInsCode && t.numericInsCode) m.numericInsCode = t.numericInsCode;
  if((!m.insCode || String(m.insCode).startsWith('json:')) && (t.insCode || t.numericInsCode)) m.insCode = t.insCode || t.numericInsCode;
  if(!m.instrumentID && t.instrumentID) m.instrumentID = t.instrumentID;
  if(!m.rowKey || String(m.rowKey).startsWith('json:')) m.rowKey = m.numericInsCode || m.instrumentID || t.rowKey || compactKey(m.symbol || t.symbol);
  if(!m.symbol && t.symbol) m.symbol = t.symbol;
  if((!m.fullName || m.fullName === m.symbol) && t.fullName) m.fullName = t.fullName;
  if(!m.sectorCode && t.sectorCode) m.sectorCode = t.sectorCode;
  if((!m.industryName || m.industryName === 'نامشخص' || /^\d+$/.test(String(m.industryName))) && t.industryName) m.industryName = t.industryName;
  if(!m.marketName && t.marketName) m.marketName = t.marketName;
  if(!m.lastPrice && t.lastPrice) m.lastPrice = t.lastPrice;
  if(!m.closePrice && t.closePrice) m.closePrice = t.closePrice;
  if(!m.yesterday && t.yesterday) m.yesterday = t.yesterday;
  if(!m.volume && t.volume) m.volume = t.volume;
  if(!m.tradeValueRial && t.tradeValueRial) m.tradeValueRial = t.tradeValueRial;
  if(!m.tradeCount && t.tradeCount) m.tradeCount = t.tradeCount;
  if(!m.hEven && t.hEven) m.hEven = t.hEven;
  if(!m.dEven && t.dEven) m.dEven = t.dEven;
  if(!m.lastPercent && m.yesterday && m.lastPrice) m.lastPercent = pctChange(m.lastPrice, m.yesterday);
  if(!m.closePercent && m.yesterday && m.closePrice) m.closePercent = pctChange(m.closePrice, m.yesterday);
  return m;
}
function dedupeMarketRows(rows){
  const map = new Map();
  for(const r of rows){
    const k = String(r.numericInsCode || r.insCode || r.instrumentID || compactKey(r.symbol) || r.rowKey || '');
    if(!k) continue;
    const prev = map.get(k);
    if(!prev || rowQuality(r) > rowQuality(prev)) map.set(k, r);
  }
  return [...map.values()];
}
function rowQuality(r){
  return (r.numericInsCode?8:0) + (r.instrumentID?4:0) + ((r.lastPrice||r.closePrice)?3:0) + (r.tradeValueRial?2:0) + (r.sectorCode?1:0);
}

function parseMarketText(text, source){
  if(!text || text.trim().startsWith('<!doctype')) throw new Error('HTML shell response, not market data');
  const records = [];
  const seenChunks = new Set();
  const addChunk = (x, list) => {
    const s = clean(String(x || '')).trim();
    if(!s || seenChunks.has(s)) return;
    seenChunks.add(s);
    list.push(s);
  };
  const chunks = [];
  // TSETMC متن دیده‌بان را گاهی به صورت چند بخش با @ و گاهی با ; / خط جدید برمی‌گرداند.
  // نسخه قبلی در بعضی پاسخ‌ها فقط آخرین بخش @ را می‌خواند و ممکن بود همه نمادها حذف شوند.
  for(const part0 of String(text).split(/[;\r\n]+/)){
    const part = String(part0 || '').trim();
    if(!part) continue;
    addChunk(part, chunks);
    if(part.includes('@')){
      for(const sec of part.split('@')) addChunk(sec, chunks);
      addChunk(part.slice(part.lastIndexOf('@') + 1), chunks);
    }
  }
  if(chunks.length < 50 && String(text).includes('@')){
    for(const sec0 of String(text).split('@')){
      for(const part of String(sec0 || '').split(/[;\r\n]+/)) addChunk(part, chunks);
    }
  }
  let tseGroupRows = 0, recordErrors = 0;
  for(const raw0 of chunks){
    try{
      let raw = String(raw0 || '').trim();
      if(!/^\d{8,},/.test(raw)) continue;
      const p = raw.split(',').map(clean);
      if(p.length < 12) continue;
      const numericInsCode = p[0];
      const insCode = numericInsCode;
      const instrumentID = p[1] || '';
      const symbol = p[2] || '';
      const fullName = p[3] || symbol;
      const rowKey = numericInsCode || instrumentID || compactKey(symbol);

      // فرمت واقعی MarketWatchInit/MarketWatchPlus سایت TSETMC در بخش فهرست نمادها:
      // p0=InsCode, p1=ISIN, p2=نماد, p3=نام, p4=قیمت دیروز/بازگشایی مرجع, p5=اولین,
      // p6=پایانی, p7=آخرین, p8=تعداد, p9=حجم, p10=ارزش, p11=کمترین,
      // p12=بیشترین, p13=دیروز/باز، p15=حجم مبنا, p17=بازار/تابلو, p18=کد گروه صنعت TSE.
      const tseSector = pickIndustryCode([p[18]]);
      const hasTseLayout = p.length >= 18 && (toNum(p[6]) || toNum(p[7]) || toNum(p[10]));
      let item;
      if(hasTseLayout){
        if(tseSector) tseGroupRows++;
        const yesterday = toNum(p[13]) || toNum(p[4]) || 0;
        item = {
          rowKey, insCode, numericInsCode, instrumentID, symbol, fullName,
          lastPrice: toNum(p[7]) || toNum(p[6]) || yesterday,
          closePrice: toNum(p[6]) || toNum(p[7]) || yesterday,
          firstPrice: toNum(p[5]),
          yesterday,
          tradeCount: toNum(p[8]),
          volume: toNum(p[9]),
          tradeValueRial: toNum(p[10]),
          priceMin: toNum(p[11]),
          priceMax: toNum(p[12]),
          baseVolume: toNum(p[15]),
          sectorCode: tseSector,
          industryName: industryFromCode(tseSector, `${symbol} ${fullName}`),
          marketName: marketFromInstrument(instrumentID, source),
          source: `${source}|tseGroup:${tseSector || 'NA'}`
        };
      }else{
        const liveFormat = toNum(p[4]) <= 235959 && (toNum(p[6]) || toNum(p[7]));
        const oldClose = liveFormat ? toNum(p[6]) : toNum(p[132]) || toNum(p[5]) || toNum(p[6]);
        const oldLast = liveFormat ? toNum(p[7]) || toNum(p[6]) : toNum(p[138]) || toNum(p[6]) || oldClose;
        const oldYesterday = liveFormat ? toNum(p[13]) : toNum(p[4]) || toNum(p[13]);
        const sectorCode = pickIndustryCode([p[18], p[25], p[22], p[28], p[29]]);
        item = {
          rowKey, insCode, numericInsCode, instrumentID, symbol, fullName,
          lastPrice: oldLast,
          closePrice: oldClose,
          firstPrice: liveFormat ? toNum(p[14]) : toNum(p[130]),
          yesterday: oldYesterday || 0,
          tradeCount: liveFormat ? toNum(p[8]) : toNum(p[144]),
          volume: liveFormat ? toNum(p[9]) : toNum(p[146]),
          tradeValueRial: liveFormat ? toNum(p[10]) : toNum(p[148]),
          priceMin: liveFormat ? toNum(p[11]) : toNum(p[150]),
          priceMax: liveFormat ? toNum(p[12]) : toNum(p[152]),
          baseVolume: liveFormat ? toNum(p[15]) : toNum(p[5]),
          sectorCode,
          industryName: industryFromCode(sectorCode, `${symbol} ${fullName}`),
          marketName: marketFromInstrument(instrumentID, source),
          source: `${source}|fallbackGroup:${sectorCode || 'guess'}`
        };
      }
      item.lastPercent = pctChange(item.lastPrice, item.yesterday);
      item.closePercent = pctChange(item.closePrice, item.yesterday);
      if(Math.abs(item.lastPercent) > 80) item.lastPercent = 0;
      if(Math.abs(item.closePercent) > 80) item.closePercent = 0;
      if(isValidMarket(item)) records.push(item);
    }catch(e){
      recordErrors++;
      if(recordErrors <= 3) state.debug.push({ stage:'parse-record-error', url:source, message:e.message || String(e), sample:String(raw0).slice(0,120) });
    }
  }
  state.debug.push({ stage:'parse-text-tse-groups', url:source, chunks:chunks.length, rows:records.length, tseGroupRows, recordErrors, note:'متن دیده‌بان با @ و ; هر دو حالت پردازش شد؛ خطای یک رکورد کل بازار را نمی‌خواباند.' });
  return records;
}

function parseMarketJson(text, source){
  const t = text.trim();
  if(t.startsWith('<')) throw new Error('HTML response, not JSON');
  const root = JSON.parse(t);
  let rawRows = [];
  if(Array.isArray(root)) rawRows = root;
  if(Array.isArray(root.marketwatch)) rawRows = rawRows.concat(root.marketwatch);
  if(Array.isArray(root.marketWatch)) rawRows = rawRows.concat(root.marketWatch);
  if(Array.isArray(root.data)) rawRows = rawRows.concat(root.data);
  if(!rawRows.length) rawRows = extractRows(root);
  const rows = rawRows.map((o,i) => normalizeMarket({ ...o, _source:source, _idx:i }))
    .filter(isValidMarket);
  return rows;
}
function extractRows(root){
  const out = [];
  const seen = new Set();
  const walk = v => {
    if(!v) return;
    if(Array.isArray(v)){ v.forEach(walk); return; }
    if(typeof v === 'object'){
      if(hasAnyKey(v, ['insCode','InsCode','instrumentID','instrumentId','insID','lva','lvc','l18','lVal18AFC','pDrCotVal','pClosing','qtj','qtc','pdv','pmd','py'])){
        const key = String(val(v,['insCode','InsCode','insID','instrumentID','instrumentId','lva','l18','symbol']) || '') + JSON.stringify(v).slice(0,50);
        if(!seen.has(key)){ seen.add(key); out.push(v); }
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(root);
  return out;
}
function normalizeMarket(o){
  const symbol = clean(String(val(o, ['lva','l18','lVal18AFC','LVal18AFC','symbol','shortName','namad']) || ''));
  const fullName = clean(String(val(o, ['lvc','l30','lVal30','LVal30','fullName','companyName','name']) || symbol));
  const instrumentID = String(val(o,['instrumentID','instrumentId','insID','InsID','isin','isinCode']) || '').trim();
  const numericIns = String(val(o, ['insCode','InsCode','inscode','nscCode','code']) || '').trim();
  // در API جدید گاهی insCode عددی وجود ندارد و فقط insID/نماد داریم؛ برای رندر و روند باید rowKey حتماً ساخته شود.
  const rowKey = numericIns || instrumentID || `json:${symbol}:${fullName}:${o._idx||0}`;
  const insCode = numericIns || instrumentID || rowKey;

  const py = toNum(val(o, ['priceYesterday','pYesterday','py','PY','yesterday','pmo']));
  const pdv = toNum(val(o, ['pdv','pDrCotVal','lastPrice','last','pl','PL','price']));
  const pmd = toNum(val(o, ['pmd','pClosing','closingPrice','close','PC']));
  const pcl = toNum(val(o, ['pcl','closingLast','finalPrice']));
  const pf = toNum(val(o, ['pf','firstPrice']));
  const pmo = toNum(val(o, ['pmo','openPrice']));
  const rawPc = toNum(val(o, ['pc']));
  const rawPcc = toNum(val(o, ['pcc','PCC']));
  const rawPcpc = toNum(val(o, ['pcpc']));
  const closeFromPc = rawPc > 100 ? rawPc : 0;

  // JSON جدید: pdv معمولاً آخرین قیمت است و pcl اگر موجود باشد پایانی معتبرتر از pmd است.
  // برای جلوگیری از خطای جنگ قیمت، پایانی را اول از pcl، سپس pmd و سپس میانگین ارزش/حجم می‌سازیم.
  const avgPrice = toNum(val(o, ['qtc'])) && toNum(val(o, ['qtj'])) ? toNum(val(o, ['qtc'])) / toNum(val(o, ['qtj'])) : 0;
  let lastPrice = pdv || pf || pmo || py;
  let closePrice = pcl || pmd || closeFromPc || avgPrice || (py && rawPcc ? py + rawPcc : 0) || pdv || py;
  if(lastPrice <= 0 && py && rawPcpc) lastPrice = py + rawPcpc;
  if(closePrice <= 0 && py) closePrice = py;

  let lastPercent = getPercent(o, ['plp','lastPercent','percentLast','pdvp','pmdp']);
  let closePercent = getPercent(o, ['pcp','closePercent','percentClose']);
  // pc و pcpc در بعضی پاسخ‌ها تغییر ریالی هستند، نه درصد. اگر کوچک باشند ممکن است درصد باشند؛ اگر قیمت دیروز داریم از قیمت‌ها محاسبه می‌کنیم.
  if(py){
    lastPercent = pctChange(lastPrice, py);
    closePercent = pctChange(closePrice, py);
  }else{
    if(!lastPercent && Math.abs(rawPcpc) < 20) lastPercent = rawPcpc;
    if(!closePercent && Math.abs(rawPcpc) < 20) closePercent = rawPcpc;
  }
  if(Math.abs(lastPercent) > 80) lastPercent = 0;
  if(Math.abs(closePercent) > 80) closePercent = 0;

  const volume = toNum(val(o, ['qTotTran5J','totalVolume','volume','tvol','qtj']));
  const tradeValueRial = toNum(val(o, ['qTotCap','totalValue','tradeValue','value','tval','qtc']));
  const tradeCount = toNum(val(o, ['zTotTran','tradeCount','count','tno','ztt']));
  const sectorCode = pickIndustryCode([val(o, ['cSecVal','sectorCode','sector','group','cs','csv'])]);
  const industryName = clean(String(val(o, ['industryName','sectorName','csName','groupName']) || industryFromCode(sectorCode, fullName)));
  return { rowKey, insCode, numericInsCode:numericIns, instrumentID, symbol, fullName, lastPrice, closePrice, yesterday:py, volume, tradeValueRial, tradeCount, sectorCode, industryName, marketName: marketFromInstrument(instrumentID, String(o._source || '')), lastPercent, closePercent, source:o._source || '' };
}
function getPercent(o, keys){
  for(const k of keys){
    const raw = o[k];
    if(raw === undefined || raw === null || raw === '') continue;
    let n = toNum(raw);
    if(Math.abs(n) > 1000) n = n / 1000;
    else if(Math.abs(n) > 100) n = n / 100;
    return n;
  }
  return 0;
}

async function fetchClients(){
  if(cachedClientMap && (Date.now() - cachedClientAt < CLIENT_CACHE_MS)){
    state.debug.push({ stage:'client-cache', rows:cachedClientMap.size, ageMs:Date.now()-cachedClientAt });
    return cachedClientMap;
  }
  const map = new Map();
  for(const url of CLIENT_URLS){
    try{
      const text = await fetchWithInfo(url);
      let rows = [];
      const t = text.trim();
      if(t.startsWith('{') || t.startsWith('[')) rows = extractRows(JSON.parse(t)).map(normClient);
      else rows = parseClientCsv(t);
      rows.filter(x=>x.insCode).forEach(c => map.set(c.insCode, c));
      state.debug.push({ stage:'parse-client', url:short(url), rows:rows.length, unique:map.size });
      if(map.size > 50){ cachedClientMap = map; cachedClientAt = Date.now(); return map; }
    }catch(e){ state.debug.push({ stage:'client-error', url:short(url), message:e.message||String(e) }); }
  }
  cachedClientMap = map; cachedClientAt = Date.now();
  return map;
}
function parseClientCsv(text){
  if(!text || text.trim().startsWith('<')) return [];
  return text.split(/[;\r\n]+/).map(x=>x.trim()).filter(Boolean).map(line => {
    const p = line.split(',').map(clean);
    return { insCode:p[0], buyCountI:toNum(p[1]), buyCountN:toNum(p[2]), buyVolI:toNum(p[3]), buyVolN:toNum(p[4]), sellCountI:toNum(p[5]), sellCountN:toNum(p[6]), sellVolI:toNum(p[7]), sellVolN:toNum(p[8]) };
  }).filter(x=>x.insCode);
}
/* v7 removed legacy duplicate normClient; canonical definition appears later. */

/* v7 removed legacy duplicate buildRows; canonical definition appears later. */

function assessDataQuality(rows, clients, market){
  const total = rows.length || 0;
  const clientMatched = rows.filter(x=>x.hasClient).length;
  const traded = rows.filter(x=>x.traded).length;
  const nonZeroValue = rows.filter(x=>(x.valueB||0)>0).length;
  const clientCoverage = total ? clientMatched / total : 0;
  const valueCoverage = total ? nonZeroValue / total : 0;
  const score = Math.round(100 * Math.min(1, (clientCoverage * 0.55) + (valueCoverage * 0.25) + (traded/Math.max(1,total) * 0.20)));
  return { total, marketRaw: market.length || 0, clientRows: clients.size || 0, clientMatched, traded, nonZeroValue, clientCoverage, valueCoverage, score };
}

function bigWeight(avgOrderB, power){
  return globalThis.RadarFormulaEngine?.largeOrderShare(avgOrderB, power) || 0;
}
function battleState(lastP, closeP, gap){
  if(lastP > 0 && closeP < 0) return { key:'reverseUp', label:'برگشت مثبت', tone:'buy' };
  if(lastP < 0 && closeP > 0) return { key:'reverseDown', label:'عقب‌نشینی آخرین', tone:'sell' };
  if(gap >= 0.6) return { key:'buyer', label:'فشار خرید لحظه‌ای', tone:'buy' };
  if(gap <= -0.6) return { key:'seller', label:'فشار فروش لحظه‌ای', tone:'sell' };
  if(Math.abs(gap) >= 0.25) return { key:gap>0?'buyerLite':'sellerLite', label:gap>0?'آخرین کمی قوی‌تر':'آخرین کمی ضعیف‌تر', tone:'warn' };
  return { key:'neutral', label:'متعادل', tone:'neu' };
}
function addSnapshot(rows){
  const overall = summarizeRows(rows);
  const groups = {};
  for(const g of [...new Set(rows.map(x=>x.assetGroup||'نامشخص'))]){
    groups[g] = summarizeRows(rows.filter(x => (x.assetGroup||'نامشخص') === g));
  }
  const snap = { time: Date.now(), ...overall, groups };
  state.history = [...(state.history||[]), snap].slice(-240);
}
function summarizeRows(rows){
  const valueB = sum(rows, x=>x.valueB);
  const weightedLast = weightedAvg(rows, x=>x.lastPercent, x=>Math.max(0.0001, x.valueB || x.volume || 1));
  const weightedClose = weightedAvg(rows, x=>x.closePercent, x=>Math.max(0.0001, x.valueB || x.volume || 1));
  return {
    count: rows.length,
    realMoneyB: sum(rows,x=>x.realMoneyB),
    bigMoneyB: sum(rows,x=>x.bigMoneyB),
    valueB,
    lastPercent: weightedLast,
    closePercent: weightedClose,
    gap: weightedLast - weightedClose,
    bigIn: rows.filter(x=>x.bigMoneyB>0).length,
    bigOut: rows.filter(x=>x.bigMoneyB<0).length,
    realIn: rows.filter(x=>x.realMoneyB>0).length,
    realOut: rows.filter(x=>x.realMoneyB<0).length
  };
}
function weightedAvg(rows, valFn, wFn){
  let n=0,d=0;
  for(const r of rows){ const v=Number(valFn(r)||0), w=Math.abs(Number(wFn(r)||0)); if(Number.isFinite(v) && Number.isFinite(w) && w>0){ n+=v*w; d+=w; } }
  return d ? n/d : 0;
}



function marketFromSource(source){ const s = String(source||''); if(s.includes('market=0')) return 'بورس'; if(s.includes('market=1')) return 'فرابورس'; return 'بورس/فرابورس'; }
function marketFromInstrument(isin, source=''){
  const x = String(isin||'').toUpperCase();
  if(x.startsWith('IRO3')) return 'فرابورس';
  if(x.startsWith('IRO1')) return 'بورس';
  return marketFromSource(source);
}

// از نسخه 6.4 به بعد «گروه» یعنی صنعت TSETMC برای سهام عادی بورس/فرابورس، نه صندوق/اوراق/حق تقدم.
// صندوق‌ها، اوراق، اختیار و حق تقدم از universe حذف می‌شوند تا رادار پول فقط صنعت سهام را نشان دهد.
const INDUSTRY_CODE_MAP = {
  '01':'زراعت و خدمات وابسته',
  '10':'استخراج زغال سنگ',
  '11':'استخراج نفت، گاز و خدمات جنبی',
  '13':'استخراج کانه‌های فلزی',
  '14':'استخراج سایر معادن',
  '17':'منسوجات',
  '19':'دباغی، چرم و کفش',
  '20':'محصولات چوبی',
  '21':'محصولات کاغذی',
  '22':'انتشار، چاپ و تکثیر',
  '23':'فرآورده‌های نفتی، کک و سوخت هسته‌ای',
  '25':'لاستیک و پلاستیک',
  '26':'محصولات رایانه‌ای، الکترونیکی و نوری',
  '27':'فلزات اساسی',
  '28':'ساخت محصولات فلزی',
  '29':'ماشین‌آلات و تجهیزات',
  '31':'ماشین‌آلات و دستگاه‌های برقی',
  '32':'ساخت دستگاه‌ها و وسایل ارتباطی',
  '33':'ابزار پزشکی، اپتیکی و اندازه‌گیری',
  '34':'خودرو و ساخت قطعات',
  '35':'سایر تجهیزات حمل‌ونقل',
  '36':'مبلمان و مصنوعات',
  '38':'قند و شکر',
  '39':'شرکت‌های چندرشته‌ای صنعتی',
  '40':'عرضه برق، گاز، بخار و آب گرم',
  '42':'محصولات غذایی و آشامیدنی به‌جز قند و شکر',
  '43':'مواد و محصولات دارویی',
  '44':'محصولات شیمیایی',
  '45':'پیمانکاری صنعتی',
  '46':'تجارت عمده‌فروشی',
  '47':'خرده‌فروشی',
  '49':'کاشی و سرامیک',
  '52':'حمل‌ونقل، انبارداری و ارتباطات',
  '53':'سیمان، آهک و گچ',
  '54':'سایر محصولات کانی غیرفلزی',
  '56':'سرمایه‌گذاری‌ها',
  '57':'بانک‌ها و مؤسسات اعتباری',
  '58':'سایر واسطه‌گری‌های مالی',
  '60':'حمل‌ونقل، انبارداری و ارتباطات',
  '64':'مخابرات',
  '65':'واسطه‌گری‌های پولی و مالی',
  '66':'بیمه و صندوق بازنشستگی به‌جز تأمین اجتماعی',
  '67':'فعالیت‌های کمکی به نهادهای مالی واسط',
  '70':'انبوه‌سازی، املاک و مستغلات',
  '71':'فعالیت مهندسی، تجزیه، تحلیل و آزمایش فنی',
  '72':'رایانه و فعالیت‌های وابسته به آن',
  '73':'اطلاعات و ارتباطات',
  '74':'خدمات فنی و مهندسی',
  '76':'هتل و رستوران',
  '77':'سایر فعالیت‌های خدماتی',
  '82':'فعالیت‌های هنری، سرگرمی و خلاقانه'
};
// Universe هدف: فقط سهام عادی + صندوق‌های سهامی/ETF.
// صندوق‌های طلا، نقره، درآمد ثابت، کالایی، اوراق، املاک و بازارگردانی عمداً حذف شده‌اند.
const EQUITY_FUND_EXACT = new Set([
  // صندوق‌های سهامی/اهرمی/شاخصی/بخشی شناخته‌شده؛ در کنار تشخیص متنی استفاده می‌شود.
  'دارا یکم','پالایش','پالایش یکم','اهرم','توان','جهش','موج','شتاب','نارنج اهرم','نارنج','بیدار','اطلس','سرو','آساس','آوند','کاریس','کارا','کاریزما','فیروزه','ثروت','هامرز','پادا','لبخند','رویش','سپند','افق','آگاس','وتوسم','مدیر','ارزش','پتروآگاه','بخشی پتروآگاه','فارما','بخشی فارما','تاراز','سلام','تابان'
].map(compactKey));
const FIXED_INCOME_FUND_EXACT = new Set([
  // چند نماد پرتکرار درآمد ثابت/اوراقی؛ این لیست فقط برای حذف محافظه‌کارانه است.
  'دارا','آفاق','صایند','کمند','کیان','کاردان','افرا','افراد','سپر','همای','آوند','لبخند','افق','اعتماد','تصمیم','رابین','داریک','پارند','پرند','نهال','امین یکم','ثابت','باثبات','سام','یاقوت','صنوین','ارمغان','کارا'
].map(compactKey));
function exactSym(r){ return compactKey(r && r.symbol ? r.symbol : ''); }
function isEtfOrFundText(r){
  const text = tokenText(`${r.symbol||''} ${r.fullName||''}`);
  return hasAny(text, ['صندوق سرمایه گذاری','صندوق سرمايه گذاري','صندوق سرمایه‌گذاری','صندوق سرمايه‌گذاری','صندوق سرمايه‌گذاري','ص.س','ص س','قابل معامله','etf','صندوق']);
}
function isNonEquityFund(r){
  const text = tokenText(`${r.symbol||''} ${r.fullName||''}`);
  if(FIXED_INCOME_FUND_EXACT.has(exactSym(r))) return true;
  return hasAny(text, [
    'طلا','سکه','سكه','نقره','زعفران','کالایی','كالايي','کالا','كالا','پشتوانه','گواهی سپرده','گواهي سپرده','سپرده کالایی','سپرده كالايي',
    'درآمد ثابت','درامد ثابت','با درآمد ثابت','بادرآمد ثابت','اوراق','مرابحه','اجاره','صکوک','صكوك','اخزا','اراد','افاد','اجاد','اماد','منفعت','سلف',
    'املاک','املاك','مستغلات','مسکن','مسكن','زمین','زمين','ساختمان','مختلط','بازارگردانی','بازارگرداني','اختصاصی بازارگردانی','اختصاصي بازارگرداني'
  ]);
}
function isEquityFund(r){
  const sym = exactSym(r);
  const text = tokenText(`${r.symbol||''} ${r.fullName||''}`);
  if(isNonEquityFund(r)) return false;
  if(EQUITY_FUND_EXACT.has(sym)) return true;
  if(hasAny(text, ['صندوق سهامی','صندوق سهامي','سهامی','سهامي','اهرمی','اهرمي','شاخصی','شاخصي','بخشی','بخشي','پالایشی','پالايشي','واسطه گری مالی یکم','واسطه گري مالي يكم'])) return true;
  // صندوق قابل معامله‌ای که صراحتاً سهامی/اهرمی/شاخصی/بخشی نباشد وارد افزونه سهام نمی‌شود؛ این کار درآمدثابت‌ها را حذف می‌کند.
  return false;
}
function instrumentClass(r){ return isEquityFund(r) ? 'صندوق سهامی/ETF' : ''; }
function industryRank(name){
  const order = ['صندوق سهامی/ETF','بانک‌ها و مؤسسات اعتباری','خودرو و ساخت قطعات','فلزات اساسی','محصولات شیمیایی','فرآورده‌های نفتی، کک و سوخت هسته‌ای','سرمایه‌گذاری‌ها','انبوه‌سازی، املاک و مستغلات','بیمه و صندوق بازنشستگی به‌جز تأمین اجتماعی','مواد و محصولات دارویی','سیمان، آهک و گچ','محصولات غذایی و آشامیدنی به‌جز قند و شکر'];
  const i = order.indexOf(name); return i === -1 ? 500 : i;
}
function groupRank(g){ return industryRank(g); }
function pickIndustryCode(vals){
  for(const v of vals){
    const raw = clean(String(v ?? '')).replace(/[^0-9]/g,'');
    if(!raw || raw.length < 2) continue; // کد تک‌رقمی مثل 1/2 معمولاً کد صنعت نیست؛ قبلاً 1 به 01 تبدیل می‌شد و نمادها اشتباهی زراعت می‌شدند.
    const c2 = raw.slice(0,2);
    if(INDUSTRY_CODE_MAP[c2]) return c2;
  }
  return '';
}
function industryFromCode(code, name=''){
  const c = pickIndustryCode([code]);
  if(c && INDUSTRY_CODE_MAP[c]) return INDUSTRY_CODE_MAP[c];
  return guessIndustryFromName(name);
}
function guessIndustryFromName(name){
  const rawName = name || '';
  const t = norm(rawName);
  const k = compactKey(rawName);
  // گروه‌بندی محافظه‌کارانه بر اساس نام/نماد؛ وقتی CDN صنعت نمی‌دهد، به اعداد پراکنده MarketWatchPlus اعتماد نمی‌کنیم.
  if(hasAny(t, ['بانک','بانك','اعتباری','اعتباري','وپاسار','وبملت','وتجارت','وبصادر','وپست','وسینا','وسينا','وخاور','ونوین','ونوين','دی','دي','سامان','وکار','وكار','وگردش'])) return 'بانک‌ها و مؤسسات اعتباری';
  if(hasAny(t, ['خودرو','خساپا','خگستر','خپارس','خاور','خبهمن','خزامیا','خزاميا','خزر','خمهر','خمحور','خاذین','خاذين','خکار','خكار','خرینگ','خرينگ','خفنر','خوساز','خشرق','خریخت','خريخت'])) return 'خودرو و ساخت قطعات';
  if(hasAny(t, ['فملی','فملي','فولاد','فخوز','ذوب','هرمز','کاوه','كاوه','فاسمین','فاسمين','فسرب','فروی','فروي','فباهنر','فایرا','فايرا','ارفع','کگل','كگل','کچاد','كچاد','ومعادن'])) return 'فلزات اساسی';
  if(hasAny(t, ['فارس','نوری','نوري','پارسان','شپدیس','شپديس','شخارک','شخارگ','شلرد','شصفها','شیران','شيران','شیراز','شيراز','کرماشا','كرماشا','زاگرس','جم','پترول'])) return 'محصولات شیمیایی';
  if(hasAny(t, ['شپنا','شبندر','شتران','شبریز','شبريز','شاوان','شنفت','شسپا','ونفت','نفت'])) return 'فرآورده‌های نفتی، کک و سوخت هسته‌ای';
  if(hasAny(t, ['سفارس','سیتا','سيتا','ساروم','سشرق','سپاها','سهرمز','سغرب','سمازن','سدور','سفانو','سکرما','سگستر'])) return 'سیمان، آهک و گچ';
  if(hasAny(t, ['وبانک','وبانك','وغدیر','وغدير','وصندوق','وامید','واميد','وتوسم','وسپه','وساپا','وخارزم','ونیرو','ونيرو','سرمایه','سرمايه'])) return 'سرمایه‌گذاری‌ها';
  if(hasAny(t, ['برکت','بركت','دتماد','دالبر','دارو','دسانکو','دسانكو','دعبید','دعبيد','دکوثر','دكوثر','دپارس','دسبحا','دروز','دفارا','دلقما'])) return 'مواد و محصولات دارویی';
    if(hasAny(t, ['بانک','بانك','اعتباری','اعتباري'])) return 'بانک‌ها و مؤسسات اعتباری';
  if(hasAny(t, ['خودرو','خودروسازی','خودروسازي','سایپا','سايپا','ایران خودرو','ايران خودرو','قطعات','محور خودرو','رینگ','رينگ','رادیاتور','رادياتور'])) return 'خودرو و ساخت قطعات';
  if(hasAny(t, ['فولاد','آهن','مس','آلومینیوم','الومينيوم','روی','روي','ذوب','فلز'])) return 'فلزات اساسی';
  if(hasAny(t, ['پتروشیمی','پتروشيمي','شیمیایی','شيميايي','کود','رنگ','اسید','اسيد'])) return 'محصولات شیمیایی';
  if(hasAny(t, ['پالایش','پالايش','نفت','روانکار','روانكار','قیر','قير'])) return 'فرآورده‌های نفتی، کک و سوخت هسته‌ای';
  if(hasAny(t, ['سرمایه گذاری','سرمايه گذاري','توسعه سرمایه','گسترش سرمایه','هلدینگ','هلدينگ'])) return 'سرمایه‌گذاری‌ها';
  if(hasAny(t, ['بیمه','بيمه'])) return 'بیمه و صندوق بازنشستگی به‌جز تأمین اجتماعی';
  if(hasAny(t, ['دارو','دارویی','دارويي','پخش'])) return 'مواد و محصولات دارویی';
  if(hasAny(t, ['سیمان','سيمان','گچ','آهک','اهك'])) return 'سیمان، آهک و گچ';
  if(hasAny(t, ['کاشی','كاشي','سرامیک','سراميك'])) return 'کاشی و سرامیک';
  if(hasAny(t, ['قند','شکر','شكر'])) return 'قند و شکر';
  if(hasAny(t, ['غذایی','غذايي','لبنیات','لبنيات','نوشیدنی','نوشيدني','روغن','دامداری','دامداري'])) return 'محصولات غذایی و آشامیدنی به‌جز قند و شکر';
  if(hasAny(t, ['زراعت','کشاورزی','كشاورزي','دامپروری','دامپروري'])) return 'زراعت و خدمات وابسته';
  if(hasAny(t, ['مخابرات','ارتباطات'])) return 'مخابرات';
  if(hasAny(t, ['رایانه','رايانه','داده','پرداخت','اطلاعات','نرم افزار','نرم‌افزار'])) return 'رایانه و فعالیت‌های وابسته به آن';
  if(hasAny(t, ['انبوه سازی','انبوه سازي','ساختمان','عمران','مسکن','مسكن','املاک','املاك','مستغلات'])) return 'انبوه‌سازی، املاک و مستغلات';
  if(hasAny(t, ['حمل و نقل','حمل‌ونقل','کشتیرانی','كشتيراني','ریل','ريل','بندر','ترابری','ترابري'])) return 'حمل‌ونقل، انبارداری و ارتباطات';
  if(hasAny(t, ['لاستیک','لاستيك','پلاستیک','پلاستيك'])) return 'لاستیک و پلاستیک';
  if(hasAny(t, ['کاغذ','كاغذ','مقوا'])) return 'محصولات کاغذی';
  if(hasAny(t, ['منسوجات','نساجی','نساجي','پشم','پارچه'])) return 'منسوجات';
  return 'سایر/نامشخص';
}
function mergeMarketMeta(r, jsonByIsin, jsonBySymbol){
  const j = (r.instrumentID && jsonByIsin.get(String(r.instrumentID).toUpperCase())) || (r.symbol && jsonBySymbol.get(compactKey(r.symbol)));
  if(!j) return finalizeMarketMeta(r);
  const merged = { ...r };
  if(!merged.sectorCode && j.sectorCode) merged.sectorCode = j.sectorCode;
  if((!merged.industryName || merged.industryName === 'نامشخص' || /^\d+$/.test(merged.industryName)) && j.industryName) merged.industryName = j.industryName;
  if(!merged.marketName || merged.marketName.includes('/')) merged.marketName = j.marketName || merged.marketName;
  if(!merged.lastPrice && j.lastPrice) merged.lastPrice = j.lastPrice;
  if(!merged.closePrice && j.closePrice) merged.closePrice = j.closePrice;
  if(!merged.yesterday && j.yesterday) merged.yesterday = j.yesterday;
  if(!merged.lastPercent && j.lastPercent) merged.lastPercent = j.lastPercent;
  if(!merged.closePercent && j.closePercent) merged.closePercent = j.closePercent;
  return finalizeMarketMeta(merged);
}
function finalizeMarketMeta(r){
  const fundGroup = instrumentClass(r);
  const code = pickIndustryCode([r.sectorCode]);
  // برای سهام عادی، اولویت مطلق با کد صنعت TSE است. حدس نام نماد فقط وقتی کد TSE موجود نباشد استفاده می‌شود.
  const industryName = fundGroup || (code ? industryFromCode(code, '') : industryFromCode('', `${r.symbol||''} ${r.fullName||''}`));
  return { ...r, sectorCode: code || r.sectorCode || '', industryName, assetGroup: industryName, marketName: fundGroup ? 'صندوق قابل معامله سهامی' : marketFromInstrument(r.instrumentID, r.source || r.marketName || '') };
}
function isExcludedInstrument(r){
  if(isEquityFund(r)) return false;
  const isin = String(r.instrumentID||'').toUpperCase();
  const text = `${r.symbol||''} ${r.fullName||''}`;
  if(isin.startsWith('IRO9')) return true; // اختیار معامله
  if(isin.startsWith('IRB')) return true;  // اوراق بدهی
  if(hasAny(text, ['حق تقدم','اختیار','اختيار','اختیارخ','اختیارف','اخزا','اراد','اجاد','افاد','اماد','مرابحه','صکوک','صكوك','اوراق','گواهی سپرده','گواهي سپرده','سپرده کالایی','سپرده كالايي','سلف','منفعت','اجاره'])) return true;
  // هر صندوقی که سهامی نباشد فعلاً از این افزونه حذف می‌شود.
  if(isEtfOrFundText(r)) return true;
  return false;
}
function isRadarUniverse(r){
  if(!isValidMarket(r)) return false;
  if(isEquityFund(r)) return true;
  if(isExcludedInstrument(r)) return false;
  const isin = String(r.instrumentID||'').toUpperCase();
  if(isin.startsWith('IRO1') || isin.startsWith('IRO3')) return true;
  // اگر ISIN نبود، فقط وقتی نماد شبیه سهم عادی است و منبع بورس/فرابورس دارد نگه‌دار.
  const m = String(r.marketName||'');
  return (m.includes('بورس') || m.includes('فرابورس')) && !/\d{2,}$/.test(norm(r.symbol||''));
}
function compactKey(s){ return norm(s).replace(/[\u200c\u200d\s_\-\.،,()\[\]{}]+/g,'').replace(/آ/g,'ا'); }
function tokenText(s){ return ` ${norm(s).replace(/[\u200c\u200d_\-\.،,()\[\]{}]+/g,' ')} `; }
function includesTerm(text, term){ return tokenText(text).includes(` ${norm(term)} `) || compactKey(text).includes(compactKey(term)); }
function hasAny(text, terms){ return terms.some(k => includesTerm(text, k)); }
function classifyAsset(r){ return instrumentClass(r) || industryFromCode(r.sectorCode, `${r.symbol||''} ${r.fullName||''}`); }
function isValidMarket(r){ return (r.rowKey || r.insCode || r.instrumentID) && r.symbol && (r.lastPrice || r.closePrice || r.yesterday || r.volume || r.tradeValueRial || r.fullName); }

function renderAll(){ renderReport(); renderAlerts(); renderAllTables(); renderGroups(); renderCharts(); renderDebug(); setMonitorBadge(!!autoTimer); }
function renderAllTables(){ renderSymbols(); renderBigMoney(); renderBattle(); }
function renderReport(){
  const rows = state.rows || [];
  const val = sum(rows, x=>x.valueB);
  const real = sum(rows, x=>x.realMoneyB);
  const big = sum(rows, x=>x.bigMoneyB);
  $('mTotal').textContent = fa(rows.length);
  $('mClient').textContent = fa(state.clientRows || 0);
  $('mValue').textContent = moneyUnit(val);
  setTextClass('mRealMoney', moneyUnit(real), cls(real));
  setTextClass('mBigMoney', moneyUnit(big), cls(big));
  if($('mPercent')) $('mPercent').textContent = `${pct(weightedAvg(rows,x=>x.lastPercent,x=>x.valueB||1))} / ${pct(weightedAvg(rows,x=>x.closePercent,x=>x.valueB||1))}`;
  if($('mBattle')) $('mBattle').textContent = `${fa(rows.filter(x=>x.gap>0).length)} خرید / ${fa(rows.filter(x=>x.gap<0).length)} فروش`;
  $('dataHealth').innerHTML = `<b>وضعیت:</b> ${rows.length ? 'به‌روز' : 'بدون داده'} | <b>نمادها:</b> ${fa(rows.length)} | <b>حقیقی/حقوقی:</b> ${pct((state.dataQuality?.clientCoverage||0)*100)} | <b>بروزرسانی:</b> ${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString('fa-IR') : '—'}`;
  mini('topBigIn', rows.filter(x=>x.bigMoneyB>0).sort((a,b)=>b.bigMoneyB-a.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`سرانه خرید ${moneyUnit(x.buyAvgOrderB)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topBigOut', rows.filter(x=>x.bigMoneyB<0).sort((a,b)=>a.bigMoneyB-b.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`سرانه فروش ${moneyUnit(x.sellAvgOrderB)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topRealIn', rows.filter(x=>x.realMoneyB>0).sort((a,b)=>b.realMoneyB-a.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت خرید ${nf(x.buyPower)}×`);
  mini('topRealOut', rows.filter(x=>x.realMoneyB<0).sort((a,b)=>a.realMoneyB-b.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت فروش ${nf(x.sellPower)}×`);
  mini('topBattleBuy', rows.filter(x=>x.gap>0).sort((a,b)=>b.gap-a.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)} | ${x.battle.label}`);
  mini('topBattleSell', rows.filter(x=>x.gap<0).sort((a,b)=>a.gap-b.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)} | ${x.battle.label}`);
  updateAllGroupSelects(rows);
}
function setTextClass(id, text, klass){ const e=$(id); if(!e) return; e.textContent=text; e.className=klass; }
function mini(id, rows, main, sub){
  const el = $(id);
  if(!el) return;
  const radarTrendIds = new Set(['topBigIn','topBigOut','topRealIn','topRealOut','topBattleBuy','topBattleSell']);
  const showSymbolTrend = radarTrendIds.has(id);
  el.innerHTML = rows.length ? rows.map((x,i)=>`<div class="item radarSymbolItem"><span class="rank">${fa(i+1)}</span><div class="symbol"><b>${symbolLink(x)}</b><small>${esc(x.fullName || '')}</small><small><span class="badge battleBadge ${x.battle?.tone||'neu'}">${esc(x.battle?.label||'—')}</span> <span class="badge">${esc(x.assetGroup||'')}</span></small></div><div class="radarItemValue"><div class="mainVal ${cls(numFrom(main(x)))}">${main(x)}</div><small>${sub(x)}</small>${showSymbolTrend && typeof miniBigTrendSpark === 'function' ? `<div class="radarInlineTrend">${miniBigTrendSpark(x)}</div>` : ''}</div></div>`).join('') : '<div class="empty">داده‌ای برای نمایش نیست.</div>';
}
function updateAllGroupSelects(rows){
  const groups = [...new Set(rows.map(x=>x.assetGroup||'نامشخص'))].sort((a,b)=>(groupRank(a)-groupRank(b)) || a.localeCompare(b,'fa'));
  const ids = ['groupSelect','bigGroupSelect','battleGroupSelect','trendGroupSelect'];
  for(const id of ids){
    const sel = $(id); if(!sel) continue;
    const current = sel.value || 'all';
    const label = id === 'trendGroupSelect' ? 'کل بازار' : 'همه گروه‌ها';
    sel.innerHTML = `<option value="all">${label}</option>` + groups.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join('');
    sel.value = groups.includes(current) ? current : 'all';
  }
}
function groupStatsList(){
  const rows = state.rows || [];
  const groups = [...new Set(rows.map(x=>x.assetGroup||'نامشخص'))];
  return groups.map(g => ({ group:g, ...summarizeRows(rows.filter(x => (x.assetGroup||'نامشخص') === g)) }))
    .sort((a,b)=>(groupRank(a.group)-groupRank(b.group)) || Math.abs(b.valueB)-Math.abs(a.valueB));
}

function renderAlerts(){
  const count = $('alertCount');
  const alerts = state.alerts || [];
  if(count) count.textContent = fa(alerts.length);

  const buyAlerts = alerts.filter(a => Number(a.amountB || 0) >= 0).slice(0, 40);
  const sellAlerts = alerts.filter(a => Number(a.amountB || 0) < 0).slice(0, 40);

  const buyCountEls = [$('alertBuyCount'), $('alertBuyCount2')].filter(Boolean);
  const sellCountEls = [$('alertSellCount'), $('alertSellCount2')].filter(Boolean);
  buyCountEls.forEach(e => e.textContent = fa(buyAlerts.length));
  sellCountEls.forEach(e => e.textContent = fa(sellAlerts.length));

  const emptyAll = '<div class="empty">هنوز رخداد لحظه‌ای ثبت نشده. اولین دریافت داده فقط خط پایه می‌سازد؛ از دریافت دوم به بعد خرید/فروش درشت ثبت می‌شود.</div>';
  const emptyBuy = '<div class="empty">فعلاً خرید لحظه‌ای درشت ثبت نشده.</div>';
  const emptySell = '<div class="empty">فعلاً فروش لحظه‌ای درشت ثبت نشده.</div>';

  const oldBoxes = [$('liveAlerts'), $('liveAlerts2')].filter(Boolean);
  if(oldBoxes.length){
    oldBoxes.forEach(box => box.innerHTML = alerts.length ? renderAlertItems(alerts.slice(0,50), false) : emptyAll);
  }

  const buyBoxes = [$('liveBuyAlerts'), $('liveBuyAlerts2')].filter(Boolean);
  const sellBoxes = [$('liveSellAlerts'), $('liveSellAlerts2')].filter(Boolean);
  buyBoxes.forEach(box => box.innerHTML = buyAlerts.length ? renderAlertItems(buyAlerts, true) : emptyBuy);
  sellBoxes.forEach(box => box.innerHTML = sellAlerts.length ? renderAlertItems(sellAlerts, true) : emptySell);
}

function renderAlertItems(list, compact=false){
  return list.map(a => {
    const buy = Number(a.amountB || 0) >= 0;
    const typeClass = buy ? 'pos' : 'neg';
    const time = new Date(a.time).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const href = a.boardUrl || '#';
    const icon = buy ? '🟢' : '🔴';
    const cum = alertCumulativeSnapshot(a);
    const cumLabel = cum.big >= 0 ? 'خالص درشت از اول بازار: ورود' : 'خالص درشت از اول بازار: خروج';
    const commonInfo = `${time} | گروه: ${esc(a.group||'نامشخص')} | آخرین ${pct(a.lastPercent)} | پایانی ${pct(a.closePercent)}`;
    if(compact){
      return `<div class="alertItem compact ${buy?'buy':'sell'}">
        <div class="alertMain"><b>${icon} ${esc(a.title)}</b><small>${commonInfo}</small></div>
        <div class="alertMetrics">
          <span class="metric ${typeClass}"><b>${moneyUnit(a.amountB)}</b><small>تغییر آپدیت</small></span>
          <span class="metric ${cls(cum.big)}"><b>${moneyUnit(cum.big)}</b><small>${cumLabel}</small></span>
          <span class="metric ${cls(a.dReal)}"><b>${moneyUnit(a.dReal)}</b><small>پول حقیقی</small></span>
        </div>
        <a class="tsetmcLink" target="_blank" rel="noopener noreferrer" href="${esc(href)}">تابلو</a>
      </div>`;
    }
    const cumDetail = `خرید درشت کل: ${moneyUnit(cum.bigBuy)} / فروش درشت کل: ${moneyUnit(cum.bigSell)}<br>خالص حقیقی نماد: ${moneyUnit(cum.real)} | ارزش معاملات: ${moneyUnit(cum.value)}`;
    return `<div class="alertItem ${buy?'buy':'sell'}">
      <div class="alertMain"><b>${icon} ${esc(a.title)}</b><small>${commonInfo}</small></div>
      <div class="alertAmount ${typeClass}">${moneyUnit(a.amountB)}<small>تغییر همین آپدیت<br>پول درشت: ${moneyUnit(a.dBig)}<br>پول حقیقی: ${moneyUnit(a.dReal)}</small></div>
      <div class="alertAmount ${cls(cum.big)}"><b>${moneyUnit(cum.big)}</b><small>${cumLabel}<br>${cumDetail}</small></div>
      <a class="tsetmcLink" target="_blank" rel="noopener noreferrer" href="${esc(href)}">تابلو</a>
    </div>`;
  }).join('');
}

function alertCumulativeSnapshot(a){
  const row = currentRowForAlert(a);
  const n = (v, fb=0) => Number.isFinite(Number(v)) ? Number(v) : fb;
  return {
    big: n(a.cumulativeBigMoneyB, n(row?.bigMoneyB, 0)),
    bigBuy: n(a.cumulativeBigBuyB, n(row?.bigBuyB, 0)),
    bigSell: n(a.cumulativeBigSellB, n(row?.bigSellB, 0)),
    real: n(a.cumulativeRealMoneyB, n(row?.realMoneyB, 0)),
    value: n(a.cumulativeValueB, n(row?.valueB, 0))
  };
}
function currentRowForAlert(a){
  const key = alertSymbolKey(a);
  const sym = compactKey(a?.symbol || '');
  return (state.rows || []).find(r => alertKey(r) === key || (sym && compactKey(r.symbol || '') === sym)) || null;
}

function alertSymbolKey(a){ return String(a?.key || a?.numericInsCode || a?.symbol || '').trim(); }

function renderGroups(){
  const data = groupStatsList();
  const total = summarizeRows(state.rows || []);
  const groupCards = $('groupCards');
  if(groupCards){
    const totalCard = data.length ? `<div class="groupTotalCard">
      <span><b>جمع کل صنعت‌ها/صندوق‌ها</b><small>${fa(total.count)} نماد | ارزش: ${moneyUnit(total.valueB)}</small></span>
      <span><small>پول حقیقی</small><b class="${cls(total.realMoneyB)}">${moneyUnit(total.realMoneyB)}</b></span>
      <span><small>پول درشت</small><b class="${cls(total.bigMoneyB)}">${moneyUnit(total.bigMoneyB)}</b></span>
    </div>` : '';
    const cards = data.length ? data.map(g=>`<button class="groupCard clickableGroup" data-group="${esc(g.group)}" title="نمایش نمادهای این گروه">
      <span><b>${esc(g.group)}</b><small>${fa(g.count)} نماد</small></span>
      <span><small>حقیقی</small><b class="${cls(g.realMoneyB)}">${moneyUnit(g.realMoneyB)}</b></span>
      <span><small>درشت</small><b class="${cls(g.bigMoneyB)}">${moneyUnit(g.bigMoneyB)}</b></span>
    </button>`).join('') : '<div class="empty">داده‌ای برای گروه‌بندی نیست.</div>';
    groupCards.innerHTML = totalCard + cards;
  }
  const body = $('groupRows'); if(body){
    if(data.length){
      const totalRow = `<tr class="totalRow"><td><b>جمع کل صنعت‌ها/صندوق‌ها</b><br><small>مجموع همه ردیف‌های همین شیت</small></td><td>${fa(total.count)}</td><td>${moneyUnit(total.valueB)}</td><td class="${cls(total.realMoneyB)}"><b>${moneyUnit(total.realMoneyB)}</b></td><td class="${cls(total.bigMoneyB)}"><b>${moneyUnit(total.bigMoneyB)}</b></td><td class="${cls(total.lastPercent)}">${pct(total.lastPercent)}</td><td class="${cls(total.closePercent)}">${pct(total.closePercent)}</td><td class="${cls(total.gap)}">${pct(total.gap)}</td></tr>`;
      body.innerHTML = totalRow + data.map(g=>`<tr class="clickableGroupRow" data-group="${esc(g.group)}" title="کلیک: نمایش نمادهای ${esc(g.group)}"><td><b>${esc(g.group)}</b><br><small>کلیک کن تا نمادهای همین گروه نمایش داده شود</small></td><td>${fa(g.count)}</td><td>${moneyUnit(g.valueB)}</td><td class="${cls(g.realMoneyB)}">${moneyUnit(g.realMoneyB)}</td><td class="${cls(g.bigMoneyB)}">${moneyUnit(g.bigMoneyB)}</td><td class="${cls(g.lastPercent)}">${pct(g.lastPercent)}</td><td class="${cls(g.closePercent)}">${pct(g.closePercent)}</td><td class="${cls(g.gap)}">${pct(g.gap)}</td></tr>`).join('');
    } else {
      body.innerHTML = '<tr><td colspan="8" class="empty">داده‌ای برای گروه‌بندی نیست.</td></tr>';
    }
  }
  renderSelectedGroupSymbols();
}
function renderSelectedGroupSymbols(){
  const selected = state.selectedGroup && state.selectedGroup !== 'all' ? state.selectedGroup : (groupStatsList()[0]?.group || 'all');
  const label = $('selectedGroupTitle');
  if(label) label.innerHTML = selected !== 'all' ? `نمادهای گروه: <b>${esc(selected)}</b>` : 'نمادهای گروه انتخاب‌شده';
  const rows = selected === 'all' ? [] : [...(state.rows||[])].filter(x => (x.assetGroup||'نامشخص') === selected).sort(sorter('bigAbs'));
  const body = $('groupSymbolRows');
  if(body){
    body.innerHTML = rows.length ? rows.slice(0,800).map(x=>`<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td><td class="${cls(x.bigMoneyB)}">${moneyUnit(x.bigMoneyB)}</td><td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td><td class="${cls(x.lastPercent)}">${pct(x.lastPercent)}</td><td class="${cls(x.closePercent)}">${pct(x.closePercent)}</td><td>${moneyUnit(x.valueB)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">روی یکی از گروه‌ها کلیک کن تا نمادهای همان گروه اینجا و در جدول نمادها نمایش داده شود.</td></tr>';
  }
}
function handleGroupClick(e){
  const el = e.target.closest('[data-group]');
  if(!el || !el.classList.contains('clickableGroup') && !el.classList.contains('clickableGroupRow')) return;
  const group = el.getAttribute('data-group');
  if(!group) return;
  openGroupSymbols(group);
}
function openGroupSymbols(group){
  state.selectedGroup = group;
  ['groupSelect','bigGroupSelect','battleGroupSelect','trendGroupSelect'].forEach(id=>{ const sel=$(id); if(sel && [...sel.options].some(o=>o.value===group)) sel.value = group; });
  const search = $('globalSearchInput'); if(search) search.value = '';
  renderAllTables();
  renderGroups();
  renderCharts();
  activate('symbols');
  setStatus(`گروه «${group}» انتخاب شد؛ نمادهای همان گروه در جدول نمادها نمایش داده شد.`);
}

function renderSymbols(){
  let rows = filteredBaseRows('searchInput');
  const g = $('groupSelect').value || 'all'; if(g !== 'all') rows = rows.filter(x => x.assetGroup === g);
  const s = $('sortSelect').value;
  rows.sort(sorter(s));
  $('symbolRows').innerHTML = rows.length ? rows.slice(0,1200).map(symbolTr).join('') : '<tr><td colspan="10" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
}
function renderBigMoney(){
  let rows = filteredBaseRows('bigSearchInput');
  const g = $('bigGroupSelect')?.value || 'all'; if(g !== 'all') rows = rows.filter(x => x.assetGroup === g);
  rows.sort(sorter($('bigModeSelect').value));
  $('bigRows').innerHTML = rows.length ? rows.slice(0,1200).map(x=>`<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td><td><span class="badge">${esc(x.assetGroup||'')}</span></td><td class="${cls(x.bigMoneyB)}"><b>${moneyUnit(x.bigMoneyB)}</b><br><small>خرید درشت ${moneyUnit(x.bigBuyB)} / فروش درشت ${moneyUnit(x.bigSellB)} | خام کانال ${moneyUnit(x.smtRawNetB||0)}</small></td><td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td><td>${moneyUnit(x.buyAvgOrderB)}</td><td>${moneyUnit(x.sellAvgOrderB)}</td><td>${nf(x.buyPower)}×</td><td>${nf(x.sellPower)}×</td><td>${pct(x.gap)}</td></tr>`).join('') : '<tr><td colspan="9" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
}
function renderBattle(){
  let rows = filteredBaseRows('battleSearchInput');
  const g = $('battleGroupSelect')?.value || 'all'; if(g !== 'all') rows = rows.filter(x => x.assetGroup === g);
  const mode = $('battleModeSelect').value;
  if(mode !== 'all') rows = rows.filter(x => x.battle.key === mode || (mode==='buyer' && x.gap>0.6) || (mode==='seller' && x.gap<-0.6));
  const buyers = [...rows].filter(x=>x.gap>0).sort((a,b)=>b.gap-a.gap).slice(0,12);
  const sellers = [...rows].filter(x=>x.gap<0).sort((a,b)=>a.gap-b.gap).slice(0,12);
  mini('battleBuyerList', buyers, x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)} | پول درشت ${moneyUnit(x.bigMoneyB)}`);
  mini('battleSellerList', sellers, x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)} | پول درشت ${moneyUnit(x.bigMoneyB)}`);
  rows.sort((a,b)=>Math.abs(b.gap)-Math.abs(a.gap));
  $('battleRows').innerHTML = rows.length ? rows.slice(0,1000).map(x=>`<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td><td><span class="badge">${esc(x.assetGroup||'')}</span></td><td><span class="badge battleBadge ${x.battle.tone}">${esc(x.battle.label)}</span></td><td class="${cls(x.lastPercent)}">${pct(x.lastPercent)}</td><td class="${cls(x.closePercent)}">${pct(x.closePercent)}</td><td class="${cls(x.gap)}"><b>${pct(x.gap)}</b></td><td class="${cls(x.bigMoneyB)}">${moneyUnit(x.bigMoneyB)}</td><td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td><td>${moneyUnit(x.valueB)}</td></tr>`).join('') : '<tr><td colspan="9" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
}
function symbolTr(x){
  return `<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td><td><span class="badge">${esc(x.assetGroup||'نامشخص')}</span><br><small>${esc(x.marketName||'')} | ${x.traded ? 'معامله‌شده' : 'بدون معامله/متوقف'}</small></td><td class="${cls(x.lastPercent)}">${pct(x.lastPercent)}</td><td class="${cls(x.closePercent)}">${pct(x.closePercent)}</td><td><span class="badge battleBadge ${x.battle.tone}">${esc(x.battle.label)}</span><br><small class="${cls(x.gap)}">${pct(x.gap)}</small></td><td class="${cls(x.bigMoneyB)}"><b>${moneyUnit(x.bigMoneyB)}</b></td><td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td><td>خرید: ${moneyUnit(x.buyAvgOrderB)}<br><small>فروش: ${moneyUnit(x.sellAvgOrderB)}</small></td><td>${nf(x.buyPower)}× / ${nf(x.sellPower)}×</td><td>${moneyUnit(x.valueB)}</td></tr>`;
}
function filteredBaseRows(inputId){
  let rows = [...(state.rows || [])];
  const globalQ = norm($('globalSearchInput')?.value || '');
  const localQ = norm($(inputId)?.value || '');
  const q = [globalQ, localQ].filter(Boolean);
  if(q.length) rows = rows.filter(x => {
    const hay = norm(`${x.symbol} ${x.fullName} ${x.assetGroup} ${x.marketName} ${x.industryName}`);
    return q.every(term => hay.includes(term));
  });
  return rows;
}
function sorter(s){
  return (a,b)=> s==='bigOut'?a.bigMoneyB-b.bigMoneyB : s==='bigAbs'?Math.abs(b.bigMoneyB)-Math.abs(a.bigMoneyB) : s==='realIn'?b.realMoneyB-a.realMoneyB : s==='realOut'?a.realMoneyB-b.realMoneyB : s==='value'?b.valueB-a.valueB : s==='buyPower'?b.buyPower-a.buyPower : s==='sellPower'?b.sellPower-a.sellPower : s==='battle'?Math.abs(b.gap)-Math.abs(a.gap) : b.bigMoneyB-a.bigMoneyB;
}

function renderCharts(){
  const rows = state.rows || [];
  bar('chartBigFlow', [...rows].sort((a,b)=>Math.abs(b.bigMoneyB)-Math.abs(a.bigMoneyB)).slice(0,18), 'bigMoneyT');
  bar('chartRealFlow', [...rows].sort((a,b)=>Math.abs(b.realMoneyB)-Math.abs(a.realMoneyB)).slice(0,18), 'realMoneyT');
  bar('chartBattle', [...rows].sort((a,b)=>Math.abs(b.gap)-Math.abs(a.gap)).slice(0,18), 'gap');
  lineHistory('chartHistory', state.history || []);
  renderTrendCharts();
  renderGroupCharts();
  renderMojStyleCharts();
  renderMoneyFlowCharts();
}
function pickSnapMetric(snap, group){
  if(group && group !== 'all') return (snap.groups && snap.groups[group]) ? snap.groups[group] : { count:0, realMoneyB:0, bigMoneyB:0, valueB:0, lastPercent:0, closePercent:0, gap:0, bigIn:0, bigOut:0, realIn:0, realOut:0 };
  return snap;
}
function renderTrendCharts(){
  const group = $('trendGroupSelect')?.value || 'all';
  const hist = (state.history || []).map(s => ({ time:s.time, ...pickSnapMetric(s, group) }));
  lineMulti('chartTrendMoney', hist, [
    {key:'realMoneyBT', label:'پول حقیقی', color:'#22c55e', from:x=>(x.realMoneyB||0)/10},
    {key:'bigMoneyBT', label:'پول درشت', color:'#a855f7', from:x=>(x.bigMoneyB||0)/10}
  ], 'میلیارد تومان');
  lineMulti('chartTrendPercent', hist, [
    {key:'lastPercent', label:'درصد آخرین', color:'#0ea5e9', from:x=>x.lastPercent||0},
    {key:'closePercent', label:'درصد پایانی', color:'#f59e0b', from:x=>x.closePercent||0}
  ], 'درصد');
  lineMulti('chartTrendValue', hist, [
    {key:'valueBT', label:'ارزش معاملات', color:'#38bdf8', from:x=>(x.valueB||0)/10}
  ], 'میلیارد تومان');
  lineMulti('chartTrendCounts', hist, [
    {key:'bigIn', label:'تعداد ورود پول درشت', color:'#22c55e', from:x=>x.bigIn||0},
    {key:'bigOut', label:'تعداد خروج پول درشت', color:'#ef4444', from:x=>x.bigOut||0}
  ], 'تعداد نماد');
}
function renderGroupCharts(){
  const data = groupStatsList().slice(0,14);
  barGeneric('chartGroupValue', data, x=>x.valueB/10, x=>x.group, 'میلیارد تومان');
  barGeneric('chartGroupMoney', data, x=>x.realMoneyB/10, x=>x.group, 'پول حقیقی - میلیارد تومان');
}


function barGeneric(id, data, valueFn, labelFn, unitLabel){
  const c=$(id); if(!c) return; const ctx=c.getContext('2d'); const w=c.width=Math.max(520,c.clientWidth); const h=c.height=Math.max(300,c.clientHeight); ctx.clearRect(0,0,w,h); ctx.fillStyle='#081323'; ctx.fillRect(0,0,w,h);
  if(!data.length){ ctx.fillStyle='#94a3b8'; ctx.textAlign='center'; ctx.font='14px Tahoma'; ctx.fillText('داده‌ای برای نمودار نیست',w/2,h/2); return; }
  const pad={l:62,r:20,t:28,b:92}; const vals=data.map(valueFn); let min=Math.min(0,...vals), max=Math.max(0,...vals); if(min===max){min-=1;max+=1;} const zero=pad.t+(h-pad.t-pad.b)-(0-min)/(max-min)*(h-pad.t-pad.b);
  ctx.strokeStyle='#334155'; ctx.beginPath(); ctx.moveTo(pad.l,zero); ctx.lineTo(w-pad.r,zero); ctx.stroke();
  ctx.fillStyle='#94a3b8'; ctx.font='12px Tahoma'; ctx.textAlign='left'; ctx.fillText(unitLabel||'',8,18); ctx.fillText(formatAxis(max),8,pad.t+8); ctx.fillText(formatAxis(min),8,h-pad.b);
  const slot=(w-pad.l-pad.r)/data.length; const bw=slot*.58;
  data.forEach((d,i)=>{ const v=Number(valueFn(d)||0); const x=pad.l+i*slot+(slot-bw)/2; const y=pad.t+(h-pad.t-pad.b)-(v-min)/(max-min)*(h-pad.t-pad.b); const top=Math.min(y,zero), bh=Math.max(2,Math.abs(zero-y)); ctx.fillStyle=v>=0?'#22c55e':'#ef4444'; ctx.fillRect(x,top,bw,bh); ctx.save(); ctx.translate(x+bw/2,h-22); ctx.rotate(-Math.PI/6); ctx.fillStyle='#cbd5e1'; ctx.font='12px Tahoma'; ctx.textAlign='center'; ctx.fillText(String(labelFn(d)||''),0,0); ctx.restore(); });
}
function lineMulti(id, hist, series, unitLabel){
  const c=$(id); if(!c) return; const ctx=c.getContext('2d'); const w=c.width=Math.max(520,c.clientWidth); const h=c.height=Math.max(300,c.clientHeight); ctx.clearRect(0,0,w,h); ctx.fillStyle='#081323'; ctx.fillRect(0,0,w,h);
  if(!hist.length){ ctx.fillStyle='#94a3b8'; ctx.textAlign='center'; ctx.font='14px Tahoma'; ctx.fillText('با چند بار به‌روزرسانی، روند اینجا شکل می‌گیرد',w/2,h/2); return; }
  const pad={l:64,r:22,t:34,b:48}; const all=[]; const values=series.map(s=>hist.map(x=>Number(s.from(x)||0))); values.forEach(v=>all.push(...v)); let min=Math.min(0,...all), max=Math.max(0,...all); if(min===max){min-=1;max+=1;}
  const y=v=>pad.t+(h-pad.t-pad.b)-(v-min)/(max-min)*(h-pad.t-pad.b); const x=i=>pad.l+i*Math.max(1,(w-pad.l-pad.r)/Math.max(1,hist.length-1));
  ctx.strokeStyle='#334155'; ctx.lineWidth=1; for(let g=0; g<=4; g++){ const yy=pad.t+g*(h-pad.t-pad.b)/4; ctx.beginPath(); ctx.moveTo(pad.l,yy); ctx.lineTo(w-pad.r,yy); ctx.stroke(); }
  const zero=y(0); ctx.strokeStyle='#64748b'; ctx.beginPath(); ctx.moveTo(pad.l,zero); ctx.lineTo(w-pad.r,zero); ctx.stroke();
  ctx.fillStyle='#94a3b8'; ctx.font='12px Tahoma'; ctx.textAlign='left'; ctx.fillText(unitLabel||'',8,18); ctx.fillText(formatAxis(max),8,pad.t+8); ctx.fillText(formatAxis(min),8,h-pad.b);
  series.forEach((ser,si)=>{ const vals=values[si]; ctx.strokeStyle=ser.color; ctx.lineWidth=2.4; ctx.beginPath(); vals.forEach((v,i)=>{ if(i===0) ctx.moveTo(x(i),y(v)); else ctx.lineTo(x(i),y(v)); }); ctx.stroke(); vals.forEach((v,i)=>{ ctx.fillStyle=ser.color; ctx.beginPath(); ctx.arc(x(i),y(v),3,0,Math.PI*2); ctx.fill(); }); ctx.fillStyle=ser.color; ctx.font='12px Tahoma'; ctx.textAlign='right'; ctx.fillText(ser.label, w-pad.r-(si*130), 18); });
  if(hist.length){ ctx.fillStyle='#94a3b8'; ctx.textAlign='center'; ctx.font='11px Tahoma'; const first=new Date(hist[0].time).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'}); const last=new Date(hist[hist.length-1].time).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'}); ctx.fillText(first,pad.l,h-14); ctx.fillText(last,w-pad.r,h-14); }
}
function bar(id,data,key){
  const c=$(id); if(!c) return; const ctx=c.getContext('2d'); const w=c.width=Math.max(520,c.clientWidth); const h=c.height=Math.max(300,c.clientHeight); ctx.clearRect(0,0,w,h); ctx.fillStyle='#081323'; ctx.fillRect(0,0,w,h);
  if(!data.length){ ctx.fillStyle='#94a3b8'; ctx.textAlign='center'; ctx.font='14px Tahoma'; ctx.fillText('داده‌ای برای نمودار نیست',w/2,h/2); return; }
  const pad={l:58,r:20,t:24,b:82}; const vals=data.map(x=>Number(chartVal(x,key)||0)); let min=Math.min(0,...vals), max=Math.max(0,...vals); if(min===max){min-=1;max+=1;} const zero=pad.t+(h-pad.t-pad.b)-(0-min)/(max-min)*(h-pad.t-pad.b); ctx.strokeStyle='#334155'; ctx.beginPath(); ctx.moveTo(pad.l,zero); ctx.lineTo(w-pad.r,zero); ctx.stroke();
  ctx.fillStyle='#94a3b8'; ctx.font='12px Tahoma'; ctx.textAlign='left'; ctx.fillText(formatAxis(max),8,pad.t+8); ctx.fillText(formatAxis(min),8,h-pad.b);
  const slot=(w-pad.l-pad.r)/data.length; const bw=slot*.58; data.forEach((d,i)=>{ const v=Number(chartVal(d,key)||0); const x=pad.l+i*slot+(slot-bw)/2; const y=pad.t+(h-pad.t-pad.b)-(v-min)/(max-min)*(h-pad.t-pad.b); const top=Math.min(y,zero), bh=Math.max(2,Math.abs(zero-y)); ctx.fillStyle=v>=0?'#22c55e':'#ef4444'; ctx.fillRect(x,top,bw,bh); ctx.save(); ctx.translate(x+bw/2,h-20); ctx.rotate(-Math.PI/6); ctx.fillStyle='#cbd5e1'; ctx.font='12px Tahoma'; ctx.textAlign='center'; ctx.fillText(String(d.symbol||''),0,0); ctx.restore(); });
}
function lineHistory(id,hist){
  const c=$(id); if(!c) return; const ctx=c.getContext('2d'); const w=c.width=Math.max(520,c.clientWidth); const h=c.height=Math.max(300,c.clientHeight); ctx.clearRect(0,0,w,h); ctx.fillStyle='#081323'; ctx.fillRect(0,0,w,h);
  if(!hist.length){ ctx.fillStyle='#94a3b8'; ctx.textAlign='center'; ctx.font='14px Tahoma'; ctx.fillText('با چند بار به‌روزرسانی، روند اینجا شکل می‌گیرد',w/2,h/2); return; }
  const pad={l:56,r:22,t:24,b:44}; const real=hist.map(x=>x.realMoneyB/10), big=hist.map(x=>x.bigMoneyB/10); let min=Math.min(0,...real,...big), max=Math.max(0,...real,...big); if(min===max){min-=1;max+=1;} const y=v=>pad.t+(h-pad.t-pad.b)-(v-min)/(max-min)*(h-pad.t-pad.b); const x=i=>pad.l+i*Math.max(1,(w-pad.l-pad.r)/Math.max(1,hist.length-1)); const zero=y(0); ctx.strokeStyle='#334155'; ctx.beginPath(); ctx.moveTo(pad.l,zero); ctx.lineTo(w-pad.r,zero); ctx.stroke(); drawLine(real,'#22c55e'); drawLine(big,'#a855f7'); ctx.fillStyle='#22c55e'; ctx.fillText('پول حقیقی',pad.l,18); ctx.fillStyle='#a855f7'; ctx.fillText('پول درشت',pad.l+90,18);
  function drawLine(vals,color){ ctx.strokeStyle=color; ctx.lineWidth=2; ctx.beginPath(); vals.forEach((v,i)=>{ if(i===0) ctx.moveTo(x(i),y(v)); else ctx.lineTo(x(i),y(v)); }); ctx.stroke(); vals.forEach((v,i)=>{ ctx.fillStyle=color; ctx.beginPath(); ctx.arc(x(i),y(v),3,0,Math.PI*2); ctx.fill(); }); }
}
function chartVal(x,key){ if(key==='realMoneyT') return Number(x.realMoneyB||0)/10; if(key==='bigMoneyT') return Number(x.bigMoneyB||0)/10; if(key==='valueT') return Number(x.valueB||0)/10; return Number(x[key]||0); }
function formatAxis(v){ return nf(v); }



async function ensureDailyValueHistory(force=false){
  const group = $('trendGroupSelect')?.value || 'all';
  const cached = state.dailyValue;
  const sameGroup = cached && cached.group === group && Array.isArray(cached.points) && cached.points.length;
  const fresh = sameGroup && cached.updatedAt && (Date.now() - cached.updatedAt < 6*60*60*1000);
  if(!force && fresh){ renderCharts(); renderDailyValueStatus(); return; }
  let rows = [...(state.rows || [])];
  if(group !== 'all') rows = rows.filter(x => x.assetGroup === group);
  rows = rows.filter(x => /^\d{8,}$/.test(String(x.numericInsCode || x.insCode || '')));
  rows.sort((a,b)=>(b.valueB||0)-(a.valueB||0));
  const selected = rows.slice(0, DAILY_VALUE_LIMIT);
  if(!selected.length){ setStatus('برای محاسبه میانگین ۵/۲۰ روزه، ابتدا داده بازار را به‌روزرسانی کن یا یک گروه دارای نماد انتخاب کن.', true); return; }
  const btn = $('dailyValueBtn'); if(btn) btn.disabled = true;
  setDailyValueStatus(`در حال دریافت سابقه ارزش معاملات ${fa(selected.length)} نماد برای ${group==='all'?'کل بازار':group}...`);
  setStatus(`در حال محاسبه میانگین ۵ و ۲۰ روزه ارزش معاملات برای ${group==='all'?'کل بازار':group}...`);
  const dateMap = new Map();
  let ok = 0, fail = 0, done = 0;
  const workerCount = Math.min(4, selected.length);
  let idx = 0;
  async function worker(){
    while(idx < selected.length){
      const r = selected[idx++];
      try{
        const recs = await fetchDailyValueRecords(r);
        if(recs.length) ok++; else fail++;
        for(const rec of recs){
          const key = rec.key;
          const prev = dateMap.get(key) || { key, time: rec.time, label: rec.label, valueB: 0, count: 0 };
          prev.valueB += rec.valueB;
          prev.count += 1;
          dateMap.set(key, prev);
        }
      }catch(e){ fail++; }
      done++;
      if(done % 25 === 0 || done === selected.length) setDailyValueStatus(`محاسبه میانگین ۵/۲۰ روزه: ${fa(done)} از ${fa(selected.length)} نماد بررسی شد...`);
    }
  }
  await Promise.all(Array.from({length:workerCount}, worker));
  let points = [...dateMap.values()].sort((a,b)=>Number(a.key)-Number(b.key));
  points = points.filter(x => Number.isFinite(x.valueB) && x.valueB >= 0).slice(-40);
  for(let i=0;i<points.length;i++){
    const vals = points.map(x=>x.valueB);
    points[i].ma5B = globalThis.RadarFormulaEngine?.movingAverageAt(vals, i, 5) ?? null;
    points[i].ma20B = globalThis.RadarFormulaEngine?.movingAverageAt(vals, i, 20) ?? null;
  }
  state.dailyValue = { group, updatedAt: Date.now(), scanned: selected.length, ok, fail, points };
  state.debug.push({ stage:'daily-value-ma', group, scanned:selected.length, ok, fail, points:points.length, note:'ارزش معاملات روزانه از سابقه نمادها جمع زده شد؛ واحد داخلی میلیارد ریال است و نمایش بر حسب تومان انجام می‌شود.' });
  await saveCache();
  renderCharts(); renderDebug(); renderDailyValueStatus();
  setStatus(`میانگین ارزش معاملات ۵ و ۲۰ روزه آماده شد: ${fa(points.length)} روز | نماد موفق: ${fa(ok)} | ناموفق: ${fa(fail)}`);
  if(btn) btn.disabled = false;
}
async function fetchDailyValueRecords(row){
  const code = String(row.numericInsCode || row.insCode || '').trim();
  if(!/^\d{8,}$/.test(code)) return [];
  const url = `https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/${encodeURIComponent(code)}/0`;
  const text = await fetchSilent(url, 12000);
  const json = JSON.parse(text);
  const arr = extractDailyArrays(json)[0] || [];
  return arr.map(o => {
    const keyRaw = val(o, ['dEven','DEven','date','dateEven','day']);
    const key = String(keyRaw || '').replace(/[^0-9]/g,'');
    const q = toNum(val(o, ['qTotCap','QTotCap','value','tradeValue','qTotCapIns','totalValue']));
    if(!key || !Number.isFinite(q) || q < 0) return null;
    return { key, time: dailyKeyToTime(key), label: dailyKeyLabel(key), valueB: q / 1e9 };
  }).filter(Boolean).slice(-45);
}
async function fetchSilent(url, timeoutMs=12000){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    const res = await fetch(url, { cache:'no-store', credentials:'omit', signal:controller.signal, headers:{ Accept:'application/json,*/*' } });
    const text = await res.text();
    if(!res.ok || !text.trim()) throw new Error(`${res.status} ${text.slice(0,80)}`);
    return text;
  }finally{ clearTimeout(timer); }
}
function extractDailyArrays(obj){
  const out = [];
  const seen = new Set();
  function walk(x){
    if(!x || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if(Array.isArray(x)){
      if(x.length && x.some(v => v && typeof v === 'object' && (hasAnyKey(v,['dEven','DEven','dateEven','date']) && hasAnyKey(v,['qTotCap','QTotCap','value','tradeValue','totalValue'])))) out.push(x);
      x.forEach(walk);
    }else Object.values(x).forEach(walk);
  }
  walk(obj);
  return out;
}
function dailyKeyToTime(key){
  const s = String(key || '');
  if(s.length >= 8){
    const y = Number(s.slice(0,4)), m = Number(s.slice(4,6)), d = Number(s.slice(6,8));
    if(y > 1800 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return new Date(y, m-1, d).getTime();
  }
  return Number(key) || Date.now();
}
function dailyKeyLabel(key){
  const s = String(key || '');
  if(s.length >= 8) return `${s.slice(6,8)}/${s.slice(4,6)}`;
  return s;
}
function setDailyValueStatus(msg){ const e=$('dailyValueStatus'); if(e) e.textContent = msg; }
function renderDailyValueStatus(){
  const group = $('trendGroupSelect')?.value || 'all';
  const dv = state.dailyValue;
  if(!dv || !dv.points?.length){ setDailyValueStatus('میانگین ۵/۲۰ روزه هنوز دریافت نشده؛ روی دکمه «میانگین ارزش ۵/۲۰ روزه» بزن.'); return; }
  const match = dv.group === group;
  const last = dv.points[dv.points.length-1];
  const time = dv.updatedAt ? new Date(dv.updatedAt).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'}) : '—';
  setDailyValueStatus(`${match?'نمایش':'کش موجود برای'} ${dv.group==='all'?'کل بازار':dv.group} | روزها: ${fa(dv.points.length)} | موفق: ${fa(dv.ok||0)} | MA5: ${moneyUnit(last.ma5B||0)} | MA20: ${moneyUnit(last.ma20B||0)} | بروزرسانی ${time}`);
}
function lineDailyValue(id, points){
  const c=$(id); if(!c) return; const ctx=c.getContext('2d'); const w=c.width=Math.max(520,c.clientWidth); const h=c.height=Math.max(300,c.clientHeight); ctx.clearRect(0,0,w,h); ctx.fillStyle='#081323'; ctx.fillRect(0,0,w,h);
  if(!points || !points.length){ ctx.fillStyle='#94a3b8'; ctx.textAlign='center'; ctx.font='14px Tahoma'; ctx.fillText('برای نمودار ۵/۲۰ روزه، روی دکمه میانگین ارزش معاملات بزن',w/2,h/2); return; }
  const series = [
    {label:'ارزش روزانه', color:'#22c55e', get:x=>(x.valueB||0)/10},
    {label:'میانگین ۵ روزه', color:'#facc15', get:x=>(x.ma5B||0)/10},
    {label:'میانگین ۲۰ روزه', color:'#38bdf8', get:x=>(x.ma20B||0)/10}
  ];
  const all = []; series.forEach(s => points.forEach(p => all.push(Number(s.get(p)||0))));
  const pad={l:72,r:24,t:36,b:58}; let min=Math.min(0,...all), max=Math.max(1,...all); if(min===max){min-=1;max+=1;}
  const y=v=>pad.t+(h-pad.t-pad.b)-(v-min)/(max-min)*(h-pad.t-pad.b); const x=i=>pad.l+i*Math.max(1,(w-pad.l-pad.r)/Math.max(1,points.length-1));
  ctx.strokeStyle='#334155'; ctx.lineWidth=1; for(let g=0; g<=4; g++){ const yy=pad.t+g*(h-pad.t-pad.b)/4; ctx.beginPath(); ctx.moveTo(pad.l,yy); ctx.lineTo(w-pad.r,yy); ctx.stroke(); }
  ctx.fillStyle='#94a3b8'; ctx.font='12px Tahoma'; ctx.textAlign='left'; ctx.fillText('میلیارد تومان',8,18); ctx.fillText(formatAxis(max),8,pad.t+8); ctx.fillText(formatAxis(min),8,h-pad.b);
  series.forEach((ser,si)=>{ ctx.strokeStyle=ser.color; ctx.lineWidth=si===0?1.8:2.6; ctx.beginPath(); points.forEach((p,i)=>{ const v=ser.get(p); if(i===0) ctx.moveTo(x(i),y(v)); else ctx.lineTo(x(i),y(v)); }); ctx.stroke(); ctx.fillStyle=ser.color; ctx.font='12px Tahoma'; ctx.textAlign='right'; ctx.fillText(ser.label, w-pad.r-(si*135), 18); });
  ctx.fillStyle='#94a3b8'; ctx.font='11px Tahoma'; ctx.textAlign='center'; const step=Math.max(1, Math.ceil(points.length/6)); points.forEach((p,i)=>{ if(i%step===0 || i===points.length-1) ctx.fillText(p.label||'', x(i), h-18); });
}

function renderMojStyleCharts(){
  const hist = state.history || [];
  const group = $('trendGroupSelect')?.value || 'all';
  const h = hist.map(s => ({ time:s.time, ...pickSnapMetric(s, group) }));
  lineMulti('chartMojPercent', h, [
    {key:'lastPercent', label:'جدال لحظه‌ای', color:'#ef4444', from:x=>x.lastPercent||0},
    {key:'closePercent', label:'جدال پایانی', color:'#fca5a5', from:x=>x.closePercent||0}
  ], 'درصد');
  lineMulti('chartMojMoney', h, [
    {key:'bigMoneyBT', label:'پول درشت', color:'#ef4444', from:x=>(x.bigMoneyB||0)/10},
    {key:'realMoneyBT', label:'پول حقیقی', color:'#fca5a5', from:x=>(x.realMoneyB||0)/10}
  ], 'میلیارد تومان');
  const dv = state.dailyValue;
  if(dv && dv.group === group && Array.isArray(dv.points) && dv.points.length){
    lineDailyValue('chartMojValue', dv.points);
  }else{
    const hv = h.map((x,i,arr)=>{
      const start = Math.max(0, i-4);
      const part = arr.slice(start, i+1);
      const avg = part.length ? part.reduce((s,a)=>s+(a.valueB||0),0)/part.length : 0;
      return {...x, valueMA:avg};
    });
    lineMulti('chartMojValue', hv, [
      {key:'valueBT', label:'ارزش لحظه‌ای', color:'#22c55e', from:x=>(x.valueB||0)/10},
      {key:'valueMAT', label:'میانگین ۵ نقطه فعلی', color:'#facc15', from:x=>(x.valueMA||0)/10}
    ], 'میلیارد تومان');
  }
  renderDailyValueStatus();
}


function historyForSelectedGroup(){
  const group = $('trendGroupSelect')?.value || 'all';
  return (state.history || []).map(s => ({ time:s.time, ...pickSnapMetric(s, group) }));
}
function renderMoneyFlowCharts(){
  const hist = historyForSelectedGroup();
  drawMoneyFlowChart('chartFlowRealRadar', hist, x => Number(x.realMoneyB || 0), 'حقیقی');
  drawMoneyFlowChart('chartFlowBigRadar', hist, x => Number(x.bigMoneyB || 0), 'درشت');
  drawMoneyFlowChart('chartFlowRealCharts', hist, x => Number(x.realMoneyB || 0), 'حقیقی');
  drawMoneyFlowChart('chartFlowBigCharts', hist, x => Number(x.bigMoneyB || 0), 'درشت');
}
function drawMoneyFlowChart(id, hist, rawFn, label){
  const c=$(id); if(!c) return;
  const ctx=c.getContext('2d');
  const w=c.width=Math.max(560,c.clientWidth||560);
  const h=c.height=Math.max(320,c.clientHeight||320);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,w,h);
  if(!hist || hist.length < 2){
    ctx.fillStyle='#64748b'; ctx.textAlign='center'; ctx.font='14px Tahoma';
    ctx.fillText('برای شکل‌گیری نمودار، چند بار به‌روزرسانی انجام بده', w/2, h/2);
    return;
  }
  const raws = hist.map(rawFn);
  const cum = raws.map(v => Number(v||0)/10); // میلیارد تومان
  const deltaRaw = raws.map((v,i)=> i===0 ? 0 : (Number(v||0) - Number(raws[i-1]||0)));
  const delta = deltaRaw.map(v => v/10);
  const lastRaw = Number(raws[raws.length-1]||0);
  const lastDeltaRaw = Number(deltaRaw[deltaRaw.length-1]||0);

  const pad={l:56,r:16,t:42,b:34};
  const mainTop=pad.t, mainBottom=h-86, barsTop=mainBottom+12, barsBottom=h-42;
  const plotW=w-pad.l-pad.r, mainH=mainBottom-mainTop, barH=barsBottom-barsTop;

  // frame / title pills
  roundedRect(ctx, 10, 10, 64, 26, 9, '#e8efff', '#90a8ff');
  drawPillText(ctx, 'مجموع', 42, 28, '#1d4ed8');
  roundedRect(ctx, 78, 10, 56, 26, 9, '#eef2ff', '#c7d2fe');
  drawPillText(ctx, 'لحظه‌ای', 106, 28, '#475569');
  ctx.fillStyle='#0f172a'; ctx.font='bold 14px Tahoma'; ctx.textAlign='right';
  ctx.fillText(`جریان پول ${label} بازار`, w-pad.r, 24);
  ctx.fillStyle='#475569'; ctx.font='12px Tahoma';
  ctx.fillText(`مجموع: ${moneyUnit(lastRaw)} | لحظه‌ای: ${moneyUnit(lastDeltaRaw)}`, w-pad.r, 40);

  let minC=Math.min(0,...cum), maxC=Math.max(0,...cum);
  if(minC===maxC){ minC-=1; maxC+=1; }
  const yMain=v=> mainTop + mainH - ((v-minC)/(maxC-minC))*mainH;
  const zeroMain=yMain(0);
  const stepX=plotW/Math.max(1,cum.length-1);
  const xAt=i=> pad.l + i*stepX;
  const maxAbsD=Math.max(1e-6, ...delta.map(v=>Math.abs(v)), 1);
  const yBar=v=> barsTop + barH/2 - (v/maxAbsD)*(barH/2-2);
  const zeroBar=barsTop + barH/2;

  // main background regions
  ctx.fillStyle='rgba(34,197,94,0.08)';
  if(zeroMain>mainTop) ctx.fillRect(pad.l, mainTop, plotW, Math.max(0, zeroMain-mainTop));
  ctx.fillStyle='rgba(239,68,68,0.08)';
  if(mainBottom>zeroMain) ctx.fillRect(pad.l, zeroMain, plotW, Math.max(0, mainBottom-zeroMain));

  // grids
  ctx.strokeStyle='#e5e7eb'; ctx.lineWidth=1;
  for(let g=0; g<=4; g++){
    const yy=mainTop + g*mainH/4; ctx.beginPath(); ctx.moveTo(pad.l,yy); ctx.lineTo(w-pad.r,yy); ctx.stroke();
  }
  ctx.setLineDash([5,4]); ctx.strokeStyle='#94a3b8';
  ctx.beginPath(); ctx.moveTo(pad.l,zeroMain); ctx.lineTo(w-pad.r,zeroMain); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad.l,zeroBar); ctx.lineTo(w-pad.r,zeroBar); ctx.stroke();
  ctx.setLineDash([]);

  // area under cumulative line
  ctx.beginPath(); ctx.moveTo(xAt(0), zeroMain);
  cum.forEach((v,i)=> ctx.lineTo(xAt(i), yMain(v)));
  ctx.lineTo(xAt(cum.length-1), zeroMain); ctx.closePath();
  const grad=ctx.createLinearGradient(0, mainTop, 0, mainBottom);
  if(lastRaw >= 0){ grad.addColorStop(0,'rgba(34,197,94,0.26)'); grad.addColorStop(1,'rgba(34,197,94,0.05)'); }
  else { grad.addColorStop(0,'rgba(239,68,68,0.20)'); grad.addColorStop(1,'rgba(239,68,68,0.05)'); }
  ctx.fillStyle=grad; ctx.fill();

  // segmented line
  for(let i=1;i<cum.length;i++){
    const x1=xAt(i-1), y1=yMain(cum[i-1]), x2=xAt(i), y2=yMain(cum[i]);
    drawSignedSegment(ctx, x1,y1,cum[i-1], x2,y2,cum[i]);
  }
  cum.forEach((v,i)=>{ ctx.fillStyle=v>=0?'#16a34a':'#dc2626'; ctx.beginPath(); ctx.arc(xAt(i), yMain(v), 2.5, 0, Math.PI*2); ctx.fill(); });

  // delta bars
  const slot=Math.max(6, plotW/Math.max(1,delta.length));
  const bw=Math.max(3, Math.min(10, slot*0.46));
  delta.forEach((v,i)=>{
    const x=xAt(i)-bw/2; const y=yBar(v); const top=Math.min(y,zeroBar), bh=Math.max(2,Math.abs(zeroBar-y));
    ctx.fillStyle=v>=0?'#16a34a':'#dc2626';
    ctx.fillRect(x, top, bw, bh);
  });

  // axis labels
  ctx.fillStyle='#475569'; ctx.font='12px Tahoma'; ctx.textAlign='left';
  ctx.fillText('میلیارد تومان', 8, 24);
  ctx.fillText(formatAxis(maxC), 8, mainTop+4);
  ctx.fillText(formatAxis(minC), 8, mainBottom);
  ctx.fillText(formatAxis(maxAbsD), 8, barsTop+4);
  ctx.fillText(formatAxis(-maxAbsD), 8, barsBottom);

  // time labels
  const step=Math.max(1, Math.ceil(hist.length/6));
  ctx.fillStyle='#334155'; ctx.textAlign='center'; ctx.font='11px Tahoma';
  hist.forEach((p,i)=>{
    if(i%step===0 || i===hist.length-1){
      const t = new Date(p.time).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'});
      ctx.fillText(t, xAt(i), h-12);
    }
  });
}
function drawSignedSegment(ctx, x1,y1,v1, x2,y2,v2){
  if((v1>=0 && v2>=0) || (v1<=0 && v2<=0)){
    ctx.strokeStyle=(v1>=0 && v2>=0)?'#16a34a':'#dc2626'; ctx.lineWidth=2.25; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); return;
  }
  const t = Math.abs(v1) / (Math.abs(v1) + Math.abs(v2));
  const xm = x1 + (x2-x1)*t; const ym = y1 + (y2-y1)*t;
  ctx.strokeStyle=v1>=0?'#16a34a':'#dc2626'; ctx.lineWidth=2.25; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(xm,ym); ctx.stroke();
  ctx.strokeStyle=v2>=0?'#16a34a':'#dc2626'; ctx.beginPath(); ctx.moveTo(xm,ym); ctx.lineTo(x2,y2); ctx.stroke();
}
function roundedRect(ctx, x, y, w, h, r, fill, stroke){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  if(fill){ ctx.fillStyle=fill; ctx.fill(); }
  if(stroke){ ctx.strokeStyle=stroke; ctx.lineWidth=1; ctx.stroke(); }
}
function drawPillText(ctx, text, x, y, color){ ctx.fillStyle=color; ctx.font='bold 12px Tahoma'; ctx.textAlign='center'; ctx.fillText(text, x, y); }

function renderDebug(){
  if(!$('debugText') || !$('debugSummary') || !$('debugTable')) return;
  const payload = { appVersion:APP_VERSION, lastUpdated:state.lastUpdated?new Date(state.lastUpdated).toLocaleString('fa-IR'):null, rows:state.rows.length, clientRows:state.clientRows, source:state.source, selectedGroup:state.selectedGroup||'all', historyPoints:(state.history||[]).length, alertCount:(state.alerts||[]).length, groups:groupStatsList().map(g=>({group:g.group,count:g.count,valueB:g.valueB,realMoneyB:g.realMoneyB,bigMoneyB:g.bigMoneyB,lastPercent:g.lastPercent,closePercent:g.closePercent})), dataQuality: state.dataQuality || {}, dailyValue: state.dailyValue ? { group:state.dailyValue.group, updatedAt:state.dailyValue.updatedAt?new Date(state.dailyValue.updatedAt).toLocaleString('fa-IR'):null, scanned:state.dailyValue.scanned, ok:state.dailyValue.ok, fail:state.dailyValue.fail, points:state.dailyValue.points?.length } : null, hotMoneyHistory: state.hotMoneyHistory ? { group:state.hotMoneyHistory.group, updatedAt:state.hotMoneyHistory.updatedAt?new Date(state.hotMoneyHistory.updatedAt).toLocaleString('fa-IR'):null, scanned:state.hotMoneyHistory.scanned, ok:state.hotMoneyHistory.ok, fail:state.hotMoneyHistory.fail, rows:state.hotMoneyHistory.rows?.length } : null, latestAlerts:(state.alerts||[]).slice(0,20), debug:state.debug };
  $('debugText').textContent = JSON.stringify(payload,null,2);
  $('debugSummary').textContent = `نمادها: ${fa(state.rows.length)} | کیفیت: ${fa(state.dataQuality?.score ?? 0)}٪ | حقیقی/حقوقی: ${fa(state.clientRows)} | نقاط روند: ${fa((state.history||[]).length)} | منبع: ${state.source || '—'}`;
  $('debugTable').innerHTML = state.debug.map((x,i)=>`<div class="debugRow ${x.ok===false?'bad':'ok'}"><div class="debugTitle">${fa(i+1)}. ${esc(x.url||x.source||x.stage)}</div><div class="debugMeta"><span>stage: ${esc(x.stage)}</span><span>status: ${esc(x.status??'—')}</span><span>rows: ${esc(x.rows??x.uniqueRows??x.unique??'—')}</span><span>length: ${esc(x.length??'—')}</span><span>ms: ${esc(x.ms??'—')}</span><span>type: ${esc(x.type||'—')}</span></div><div class="sample">${esc(x.sample||x.message||'')}</div></div>`).join('') || '<div class="empty">هنوز عیب‌یابی ثبت نشده.</div>';
}
async function copyDebug(){ try{ const e = $('debugText'); await navigator.clipboard.writeText(e ? e.textContent : ''); setStatus('عیب‌یابی کپی شد.'); }catch{ setStatus('کپی انجام نشد؛ دستی کپی کن.', true); } }


function makeTsetmcUrl(x){
  const code = String(x.numericInsCode || x.insCode || '').trim();
  if(/^\d{8,}$/.test(code)) return `https://old.tsetmc.com/Loader.aspx?ParTree=151311&i=${encodeURIComponent(code)}`;
  const isin = String(x.instrumentID || '').trim();
  if(isin) return `https://www.tsetmc.com/instInfo/${encodeURIComponent(isin)}`;
  return 'https://www.tsetmc.com/';
}
function symbolLink(x){
  const href = x.boardUrl || makeTsetmcUrl(x);
  return `<a class="tsetmcLink" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="باز کردن تابلو در TSETMC">${esc(x.symbol || '')}</a>`;
}
function hasAnyKey(o,keys){ return keys.some(k => o && Object.prototype.hasOwnProperty.call(o,k)); }
function val(o, keys){ for(const k of keys){ if(o && o[k] !== undefined && o[k] !== null) return o[k]; } return undefined; }
function clean(s){ return String(s ?? '').replace(/[\u200c\u200f\ufeff]/g,'').trim(); }
function toNum(v){ if(v == null || v === '') return 0; if(typeof v === 'number') return Number.isFinite(v)?v:0; const s=String(v).replace(/<[^>]*>/g,'').replace(/[٬,\s]/g,'').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)); const n=Number(s); return Number.isFinite(n)?n:0; }
function pctChange(a,b){ return b ? ((a-b)/b)*100 : 0; }
function sum(a,fn){ return a.reduce((s,x)=>s+Number(fn(x)||0),0); }
function fa(x){ return String(x).replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]); }
function nf(n){ return fa(Number(n||0).toLocaleString('en-US',{maximumFractionDigits:2})); }
// ورودی این تابع میلیارد ریال است؛ خروجی کوتاه‌شده بر حسب تومان است.
// م.ت = میلیون تومان | ب.ت = میلیارد تومان | همت = هزار میلیارد تومان
function moneyUnit(billionRial){
  const br = Number(billionRial || 0);
  const bt = globalThis.RadarFormulaEngine ? globalThis.RadarFormulaEngine.billionRialToBillionToman(br) : br / 10; // میلیارد تومان
  if(Math.abs(bt) >= 1) return `${nf(bt)} میلیارد تومان`;
  return `${nf(bt * 1000)} میلیون تومان`;
}
function unitLegendHtml(){ return '<b>واحد:</b> تومان'; }
function pct(n){ const v=Number(n||0); return `${v>0?'+':''}${nf(v)}٪`; }
function cls(n){ return Number(n)>0?'pos':Number(n)<0?'neg':'neu'; }
function norm(s){ return clean(s).replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/ۀ/g,'ه').replace(/[ً-ٰٟ]/g,'').toLowerCase(); }
function esc(s){ return String(s ?? '').replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
function short(url){ try{ const u=new URL(url); return u.hostname+u.pathname+(u.search?u.search:''); }catch{return String(url);} }
function numFrom(s){ return Number(String(s).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[^0-9\-.]/g,'')) || 0; }


/* ===== Big Money 3/5-day extension patch =====
   Adds on-demand 3/5 trading-day big-money calculation using:
   - ClosingPrice/GetClosingPriceDailyList/:InsCode/0 for last trading dates and close/value
   - ClientType/GetClientTypeHistory/:InsCode/:DEven for historical individual/legal volumes
*/
const HOT_MONEY_LIMIT = 500;
const HOT_CLIENT_WORKERS = 4;

window.addEventListener('DOMContentLoaded', () => {
  const btn = $('hotMoneyBtn');
  if(btn) btn.addEventListener('click', () => ensureHotMoneyHistory(true));
  renderHotMoneyStatus();
});

function getHotMoneyGroup(){
  return $('bigGroupSelect')?.value || $('trendGroupSelect')?.value || 'all';
}
function hotMoneyMap(){
  const rows = state.hotMoneyHistory?.rows || [];
  const mp = new Map();
  rows.forEach(x => { if(x.key) mp.set(String(x.key), x); if(x.symbol) mp.set('sym:'+compactKey(x.symbol), x); });
  return mp;
}
function hotForRow(r){
  const mp = hotMoneyMap();
  return mp.get(alertKey(r)) || mp.get('sym:'+compactKey(r.symbol||'')) || null;
}
function hotMoneyCell(h){
  if(!h) return '<td class="muted">—</td><td class="muted">—</td><td class="muted">—</td><td class="muted">—</td><td class="muted">—</td><td class="muted">—</td><td class="muted">—</td>';
  return `<td class="pos"><b>${moneyUnit(h.bigBuy3B)}</b></td>`+
         `<td class="neg"><b>${moneyUnit(h.bigSell3B)}</b></td>`+
         `<td class="${cls(h.hot3B)}"><b>${moneyUnit(h.hot3B)}</b><br><small>حقیقی ${moneyUnit(h.real3B)}</small></td>`+
         `<td class="pos"><b>${moneyUnit(h.bigBuy5B)}</b></td>`+
         `<td class="neg"><b>${moneyUnit(h.bigSell5B)}</b></td>`+
         `<td class="${cls(h.hot5B)}"><b>${moneyUnit(h.hot5B)}</b><br><small>حقیقی ${moneyUnit(h.real5B)}</small></td>`+
         `<td><small>${fa(h.okDays||0)} روز معتبر<br>${esc(h.lastLabel||'')}</small></td>`;
}
function renderHotMoneyStatus(){
  const e = $('hotMoneyStatus');
  if(!e) return;
  const hm = state.hotMoneyHistory;
  if(!hm || !Array.isArray(hm.rows) || !hm.rows.length){
    e.textContent = 'خالص پول درشت ۳/۵ روزه هنوز محاسبه نشده. بعد از به‌روزرسانی بازار، دکمه «خالص پول درشت ۳/۵ روزه» را بزن.';
    return;
  }
  const time = hm.updatedAt ? new Date(hm.updatedAt).toLocaleString('fa-IR') : '—';
  e.innerHTML = `خالص پول درشت ۳/۵ روزه آماده است | گروه: <b>${esc(hm.group==='all'?'کل بازار':hm.group)}</b> | نماد بررسی‌شده: <b>${fa(hm.scanned||0)}</b> | موفق: <b>${fa(hm.ok||0)}</b> | ناموفق: <b>${fa(hm.fail||0)}</b> | بروزرسانی: ${time}`;
}
async function ensureHotMoneyHistory(force=false){
  const group = getHotMoneyGroup();
  const cached = state.hotMoneyHistory;
  const fresh = cached && cached.group === group && cached.updatedAt && (Date.now() - cached.updatedAt < 90*60*1000) && (cached.rows||[]).length;
  if(!force && fresh){ renderAllTables(); renderHotMoneyStatus(); return; }
  let rows = [...(state.rows || [])];
  if(group !== 'all') rows = rows.filter(x => x.assetGroup === group);
  rows = rows.filter(x => /^\d{8,}$/.test(String(x.numericInsCode || x.insCode || '')));
  rows.sort((a,b)=>(b.valueB||0)-(a.valueB||0));
  const selected = rows.slice(0, HOT_MONEY_LIMIT);
  if(!selected.length){ setStatus('برای محاسبه خالص پول درشت ۳/۵ روزه، ابتدا داده بازار را به‌روزرسانی کن یا یک گروه دارای نماد انتخاب کن.', true); return; }
  const btn = $('hotMoneyBtn'); if(btn) btn.disabled = true;
  const status = $('hotMoneyStatus'); if(status) status.textContent = `در حال محاسبه ورود/خروج خالص پول درشت ۳/۵ روزه برای ${fa(selected.length)} نماد...`;
  setStatus(`در حال دریافت سابقه حقیقی/حقوقی برای ورود/خروج پول درشت ۳ و ۵ روزه برای ${group==='all'?'کل بازار':group}...`);
  const out = [];
  let idx = 0, ok = 0, fail = 0, done = 0;
  async function worker(){
    while(idx < selected.length){
      const r = selected[idx++];
      try{
        const h = await fetchHotMoneyForRow(r);
        if(h && h.okDays){ out.push(h); ok++; } else fail++;
      }catch(e){
        fail++;
        state.debug.push({ stage:'hotmoney-symbol-error', symbol:r.symbol, insCode:r.numericInsCode||r.insCode, message:e.message||String(e) });
      }
      done++;
      if(done % 15 === 0 || done === selected.length){
        if(status) status.textContent = `محاسبه ورود/خروج خالص پول درشت ۳/۵ روزه: ${fa(done)} از ${fa(selected.length)} نماد بررسی شد...`;
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(HOT_CLIENT_WORKERS, selected.length)}, worker));
  out.sort((a,b)=>Math.max(Math.abs(b.hot5B||0),b.bigBuy5B||0,b.bigSell5B||0)-Math.max(Math.abs(a.hot5B||0),a.bigBuy5B||0,a.bigSell5B||0));
  state.hotMoneyHistory = { group, updatedAt: Date.now(), scanned:selected.length, ok, fail, rows: out };
  state.debug.push({ stage:'bigmoney-3-5-ready', group, scanned:selected.length, ok, fail, rows:out.length, note:'ورود، خروج و خالص خالص پول درشت ۳/۵ روزه از ClientTypeHistory هر نماد محاسبه شده؛ واحد داخلی میلیارد ریال است و نمایش بر حسب تومان است.' });
  await saveCache();
  renderAllTables(); renderHotMoneyStatus(); renderDebug();
  setStatus(`ورود/خروج خالص پول درشت ۳/۵ روزه آماده شد: موفق ${fa(ok)} | ناموفق ${fa(fail)}`);
  if(btn) btn.disabled = false;
}
async function fetchHotMoneyForRow(row){
  const code = String(row.numericInsCode || row.insCode || '').trim();
  if(!/^\d{8,}$/.test(code)) return null;
  const daily = await fetchDailyMarketRecords(row);
  const historyDays = daily.slice(-5).reverse(); // latest first
  const dayStats = [];
  // روز جاری/آخرین وضعیت داخل بازار را هم به‌عنوان روز اول لحاظ می‌کنیم تا با نمایه پول درشت امروز هم‌خوان باشد.
  if(row.hasClient){
    dayStats.push({ key:'today', label:'امروز', hotB:Number(row.bigMoneyB||0), realB:Number(row.realMoneyB||0), bigBuyB:Number(row.bigBuyB||0), bigSellB:Number(row.bigSellB||0), valueB:Number(row.valueB||0) });
  }
  for(const d of historyDays){
    if(dayStats.length >= 5) break;
    try{
      const c = await fetchClientTypeForDay(code, d.key);
      if(!c || !(c.buyVolI || c.sellVolI || c.buyCountI || c.sellCountI)) continue;
      const price = Number(d.closePrice || row.closePrice || row.lastPrice || 0);
      const stat = calcHotFromClient(c, price, Number(d.valueB||0));
      dayStats.push({ key:d.key, label:d.label, ...stat });
    }catch(e){ /* skip day */ }
  }
  const d3 = dayStats.slice(0,3), d5 = dayStats.slice(0,5);
  const sum = (arr,k)=>arr.reduce((s,x)=>s+Number(x[k]||0),0);
  return {
    key: alertKey(row), symbol: row.symbol, fullName: row.fullName, group: row.assetGroup, boardUrl: row.boardUrl,
    okDays: dayStats.length,
    hot3B: sum(d3,'hotB'), hot5B: sum(d5,'hotB'),
    real3B: sum(d3,'realB'), real5B: sum(d5,'realB'),
    bigBuy3B: sum(d3,'bigBuyB'), bigSell3B: sum(d3,'bigSellB'), bigBuy5B: sum(d5,'bigBuyB'), bigSell5B: sum(d5,'bigSellB'),
    value3B: sum(d3,'valueB'), value5B: sum(d5,'valueB'),
    lastLabel: dayStats.map(x=>x.label).slice(0,5).join('، ')
  };
}
function calcHotFromClient(c, price, valueB=0){
  const fm = globalThis.RadarFormulaEngine?.computeClientMetrics({ client:c, priceRial:Number(price||0), preferDirectValues:true });
  if(!fm) return { hotB:0, realB:0, bigBuyB:0, bigSellB:0, valueB };
  return { hotB:fm.bigMoneyB, realB:fm.realMoneyB, bigBuyB:fm.bigBuyB, bigSellB:fm.bigSellB, valueB };
}
async function fetchDailyMarketRecords(row){
  const code = String(row.numericInsCode || row.insCode || '').trim();
  const url = `https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/${encodeURIComponent(code)}/0`;
  const text = await fetchSilent(url, 12000);
  const json = JSON.parse(text);
  const arr = extractDailyArrays(json)[0] || [];
  return arr.map(o => {
    const keyRaw = val(o, ['dEven','DEven','date','dateEven','day']);
    const key = String(keyRaw || '').replace(/[^0-9]/g,'');
    if(!key) return null;
    const q = toNum(val(o, ['qTotCap','QTotCap','value','tradeValue','qTotCapIns','totalValue']));
    const closePrice = toNum(val(o, ['pClosing','PClosing','pDrCotVal','PDrCotVal','close','closePrice','finalPrice','pClose']));
    return { key, time: dailyKeyToTime(key), label: dailyKeyLabel(key), valueB: q / 1e9, closePrice };
  }).filter(Boolean).sort((a,b)=>Number(a.key)-Number(b.key)).slice(-25);
}
async function fetchClientTypeForDay(insCode, dEven){
  const url = `https://cdn.tsetmc.com/api/ClientType/GetClientTypeHistory/${encodeURIComponent(insCode)}/${encodeURIComponent(dEven)}`;
  const text = await fetchSilent(url, 10000);
  const t = text.trim();
  let obj;
  try{ obj = JSON.parse(t); }catch(e){
    const rows = parseClientCsv(t);
    return rows[0] || null;
  }
  const candidates = extractClientHistoryObjects(obj);
  let best = null;
  for(const c0 of candidates){
    const c = normClient(c0); if(!c.insCode) c.insCode = String(insCode);
    const score = (c.buyVolI||0)+(c.sellVolI||0)+(c.buyCountI||0)+(c.sellCountI||0);
    if(score && (!best || score > best._score)) best = { ...c, _score:score };
  }
  if(!best && obj && typeof obj === 'object'){
    const c = normClient(obj); if(!c.insCode) c.insCode = String(insCode);
    if(c.buyVolI || c.sellVolI || c.buyCountI || c.sellCountI) best = c;
  }
  return best;
}
function extractClientHistoryObjects(root){
  const out = [];
  const seen = new Set();
  const clientKeys = ['buy_I_Volume','Buy_I_Volume','buyIVolume','buy_CountI','Buy_CountI','buyICount','buy_I_Count','Buy_I_Count','buy_I_Value','Buy_I_Value','sell_I_Volume','Sell_I_Volume','sellIVolume','sell_CountI','Sell_CountI','sellICount','sell_I_Count','Sell_I_Count','sell_I_Value','Sell_I_Value','buy_N_Volume','sell_N_Volume'];
  function walk(x){
    if(!x || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if(Array.isArray(x)){ x.forEach(walk); return; }
    if(hasAnyKey(x, clientKeys)) out.push(x);
    Object.values(x).forEach(walk);
  }
  walk(root);
  return out;
}

// Override big-money renderer to show 3/5-day hot money columns
function renderBigMoney(){
  let rows = filteredBaseRows('bigSearchInput');
  const g = $('bigGroupSelect')?.value || 'all'; if(g !== 'all') rows = rows.filter(x => x.assetGroup === g);
  rows.sort(sorter($('bigModeSelect').value));
  const body = $('bigRows'); if(!body) return;
  body.innerHTML = rows.length ? rows.slice(0,1200).map(x=>{
    const h = hotForRow(x);
    return `<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td><td><span class="badge">${esc(x.assetGroup||'')}</span></td><td class="${cls(x.bigMoneyB)}"><b>${moneyUnit(x.bigMoneyB)}</b><br><small>خرید درشت ${moneyUnit(x.bigBuyB)} / فروش درشت ${moneyUnit(x.bigSellB)} | خام کانال ${moneyUnit(x.smtRawNetB||0)}</small></td><td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td>${hotMoneyCell(h)}<td>${moneyUnit(x.buyAvgOrderB)}</td><td>${moneyUnit(x.sellAvgOrderB)}</td><td>${nf(x.buyPower)}×</td><td>${nf(x.sellPower)}×</td><td>${pct(x.gap)}</td></tr>`;
  }).join('') : '<tr><td colspan="16" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
  renderHotMoneyStatus();
}


/* ===== v display-fix patch: explicit 3/5-day big-money results table ===== */
function hotMoneyScopeMatchesForRow(row){
  const hm = state.hotMoneyHistory;
  if(!hm || !hm.group) return false;
  if(hm.group === 'all') return true;
  return String(row.assetGroup || '') === String(hm.group);
}
function hotMoneyMap(){
  const rows = state.hotMoneyHistory?.rows || [];
  const mp = new Map();
  rows.forEach(x => {
    if(x.key) mp.set(String(x.key), x);
    if(x.symbol) mp.set('sym:'+compactKey(x.symbol), x);
  });
  return mp;
}
function hotForRow(r){
  const hm = state.hotMoneyHistory;
  if(!hm || !Array.isArray(hm.rows) || !hm.rows.length) return null;
  const activeGroup = $('bigGroupSelect')?.value || 'all';
  if(activeGroup !== 'all' && hm.group !== 'all' && activeGroup !== hm.group) return null;
  if(hm.group !== 'all' && activeGroup === 'all' && String(r.assetGroup||'') !== String(hm.group)) return null;
  const mp = hotMoneyMap();
  return mp.get(alertKey(r)) || mp.get(String(r.numericInsCode || r.insCode || '')) || mp.get('sym:'+compactKey(r.symbol||'')) || null;
}
function renderAllTables(){
  renderSymbols();
  renderBigMoney();
  renderHotMoneyResultsTable();
  renderBattle();
}
function renderBigMoney(){
  let rows = filteredBaseRows('bigSearchInput');
  const g = $('bigGroupSelect')?.value || 'all';
  if(g !== 'all') rows = rows.filter(x => x.assetGroup === g);
  rows.sort(sorter($('bigModeSelect').value));
  const body = $('bigRows'); if(!body) return;
  body.innerHTML = rows.length ? rows.slice(0,1200).map(x=>{
    const h = hotForRow(x);
    return `<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td>`+
      `<td><span class="badge">${esc(x.assetGroup||'')}</span></td>`+
      `<td class="${cls(x.bigMoneyB)}"><b>${moneyUnit(x.bigMoneyB)}</b><br><small>خرید درشت ${moneyUnit(x.bigBuyB)} / فروش درشت ${moneyUnit(x.bigSellB)} | خام کانال ${moneyUnit(x.smtRawNetB||0)}</small></td>`+
      `<td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td>`+
      hotMoneyCell(h)+
      `<td>${moneyUnit(x.buyAvgOrderB)}</td><td>${moneyUnit(x.sellAvgOrderB)}</td><td>${nf(x.buyPower)}×</td><td>${nf(x.sellPower)}×</td><td>${pct(x.gap)}</td></tr>`;
  }).join('') : '<tr><td colspan="16" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
  renderHotMoneyStatus();
}
function renderHotMoneyResultsTable(){
  const body = $('hotMoneyRows');
  const info = $('hotMoneySummary');
  if(!body) return;
  const hm = state.hotMoneyHistory;
  const activeGroup = $('bigGroupSelect')?.value || 'all';
  if(!hm || !Array.isArray(hm.rows) || !hm.rows.length){
    if(info) info.textContent = 'هنوز محاسبه نشده؛ گروه موردنظر را انتخاب کن و دکمه «خالص پول درشت ۳/۵ روزه» را بزن.';
    body.innerHTML = '<tr><td colspan="12" class="empty">نتیجه‌ای برای نمایش نیست.</td></tr>';
    return;
  }
  let rows = hm.rows || [];
  if(activeGroup !== 'all'){
    if(hm.group !== 'all' && activeGroup !== hm.group){
      if(info) info.innerHTML = `نتیجه موجود برای <b>${esc(hm.group==='all'?'کل بازار':hm.group)}</b> است؛ الان فیلتر روی <b>${esc(activeGroup)}</b> است. برای این گروه دوباره دکمه را بزن.`;
      body.innerHTML = '<tr><td colspan="12" class="empty">نتیجه این گروه هنوز محاسبه نشده.</td></tr>';
      return;
    }
    rows = rows.filter(x => String(x.group||'') === String(activeGroup));
  }
  const sum = (k)=>rows.reduce((s,x)=>s+Number(x[k]||0),0);
  const time = hm.updatedAt ? new Date(hm.updatedAt).toLocaleString('fa-IR') : '—';
  if(info) info.innerHTML = `نتیجه قابل نمایش: <b>${fa(rows.length)}</b> نماد | محدوده محاسبه: <b>${esc(hm.group==='all'?'کل بازار':hm.group)}</b> | ورود ۳روزه: <b class="pos">${moneyUnit(sum('bigBuy3B'))}</b> | خروج ۳روزه: <b class="neg">${moneyUnit(sum('bigSell3B'))}</b> | خالص ۳روزه: <b class="${cls(sum('hot3B'))}">${moneyUnit(sum('hot3B'))}</b> | ورود ۵روزه: <b class="pos">${moneyUnit(sum('bigBuy5B'))}</b> | خروج ۵روزه: <b class="neg">${moneyUnit(sum('bigSell5B'))}</b> | خالص ۵روزه: <b class="${cls(sum('hot5B'))}">${moneyUnit(sum('hot5B'))}</b> | بروزرسانی: ${time}`;
  const srt = rows.slice().sort((a,b)=>Math.max(Math.abs(b.hot5B||0), b.bigBuy5B||0, b.bigSell5B||0)-Math.max(Math.abs(a.hot5B||0), a.bigBuy5B||0, a.bigSell5B||0));
  body.innerHTML = srt.length ? srt.map(h=>`<tr>`+
    `<td><b>${h.boardUrl?`<a href="${esc(h.boardUrl)}" target="_blank" rel="noopener">${esc(h.symbol||'')}</a>`:esc(h.symbol||'')}</b><br><small>${esc(h.fullName||'')}</small></td>`+
    `<td><span class="badge">${esc(h.group||'')}</span></td>`+
    `<td class="pos"><b>${moneyUnit(h.bigBuy3B)}</b></td>`+
    `<td class="neg"><b>${moneyUnit(h.bigSell3B)}</b></td>`+
    `<td class="${cls(h.hot3B)}"><b>${moneyUnit(h.hot3B)}</b><br><small>حقیقی ${moneyUnit(h.real3B)}</small></td>`+
    `<td class="pos"><b>${moneyUnit(h.bigBuy5B)}</b></td>`+
    `<td class="neg"><b>${moneyUnit(h.bigSell5B)}</b></td>`+
    `<td class="${cls(h.hot5B)}"><b>${moneyUnit(h.hot5B)}</b><br><small>حقیقی ${moneyUnit(h.real5B)}</small></td>`+
    `<td>${moneyUnit(h.value3B)}</td><td>${moneyUnit(h.value5B)}</td>`+
    `<td>${fa(h.okDays||0)}</td><td><small>${esc(h.lastLabel||'')}</small></td>`+
    `</tr>`).join('') : '<tr><td colspan="12" class="empty">برای فیلتر فعلی نتیجه‌ای نیست؛ گروه را عوض کن یا دوباره محاسبه بزن.</td></tr>';
}


/* ===== v net-bigmoney-3/5 override patch ===== */
function moneyMaybe(v){ return (v === null || v === undefined || Number.isNaN(Number(v))) ? '<span class="muted">—</span>' : moneyUnit(v); }
function hotMoneyCell(h){
  if(!h) return '<td class="muted">—</td><td class="muted">—</td><td class="muted">—</td>';
  const n3 = (h.net3B === null || h.net3B === undefined || Number.isNaN(Number(h.net3B))) ? null : Number(h.net3B);
  const n5 = (h.net5B === null || h.net5B === undefined || Number.isNaN(Number(h.net5B))) ? null : Number(h.net5B);
  return `<td class="${cls(n3)}"><b>${moneyMaybe(n3)}</b></td>`+
         `<td class="${cls(n5)}"><b>${moneyMaybe(n5)}</b></td>`+
         `<td><small>${fa(h.okDays||0)} روز معتبر<br>${esc(h.lastLabel||'')}</small></td>`;
}
function renderHotMoneyStatus(){
  const e = $('hotMoneyStatus');
  if(!e) return;
  const hm = state.hotMoneyHistory;
  if(!hm || !Array.isArray(hm.rows) || !hm.rows.length){
    e.textContent = 'خالص پول درشت ۳/۵ روزه هنوز محاسبه نشده. بعد از به‌روزرسانی بازار، دکمه را بزن.';
    return;
  }
  const time = hm.updatedAt ? new Date(hm.updatedAt).toLocaleString('fa-IR') : '—';
  e.innerHTML = `خالص پول درشت ۳/۵ روزه آماده است | گروه: <b>${esc(hm.group==='all'?'کل بازار':hm.group)}</b> | نماد بررسی‌شده: <b>${fa(hm.scanned||0)}</b> | موفق: <b>${fa(hm.ok||0)}</b> | ناموفق: <b>${fa(hm.fail||0)}</b> | بروزرسانی: ${time}`;
}
async function ensureHotMoneyHistory(force=false){
  const group = getHotMoneyGroup();
  const cached = state.hotMoneyHistory;
  const fresh = cached && cached.group === group && cached.updatedAt && (Date.now() - cached.updatedAt < 90*60*1000) && (cached.rows||[]).length;
  if(!force && fresh){ renderAllTables(); renderHotMoneyStatus(); return; }
  let rows = [...(state.rows || [])];
  if(group !== 'all') rows = rows.filter(x => x.assetGroup === group);
  rows = rows.filter(x => /^\d{8,}$/.test(String(x.numericInsCode || x.insCode || '')));
  rows.sort((a,b)=>(b.valueB||0)-(a.valueB||0));
  const selected = rows.slice(0, HOT_MONEY_LIMIT);
  if(!selected.length){ setStatus('برای محاسبه خالص پول درشت ۳/۵ روزه، ابتدا داده بازار را به‌روزرسانی کن یا یک گروه دارای نماد انتخاب کن.', true); return; }
  const btn = $('hotMoneyBtn'); if(btn) btn.disabled = true;
  const status = $('hotMoneyStatus'); if(status) status.textContent = `در حال محاسبه خالص پول درشت ۳/۵ روزه برای ${fa(selected.length)} نماد...`;
  setStatus(`در حال دریافت سابقه حقیقی/حقوقی برای خالص پول درشت ۳ و ۵ روزه برای ${group==='all'?'کل بازار':group}...`);
  const out = [];
  let idx = 0, ok = 0, fail = 0, done = 0;
  async function worker(){
    while(idx < selected.length){
      const r = selected[idx++];
      try{
        const h = await fetchHotMoneyForRow(r);
        if(h && h.okDays){ out.push(h); ok++; } else fail++;
      }catch(e){
        fail++;
        state.debug.push({ stage:'net-bigmoney-symbol-error', symbol:r.symbol, insCode:r.numericInsCode||r.insCode, message:e.message||String(e) });
      }
      done++;
      if(done % 15 === 0 || done === selected.length){
        if(status) status.textContent = `محاسبه خالص پول درشت ۳/۵ روزه: ${fa(done)} از ${fa(selected.length)} نماد بررسی شد...`;
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(HOT_CLIENT_WORKERS, selected.length)}, worker));
  out.sort((a,b)=>Math.max(Math.abs(b.net5B||0),Math.abs(b.net3B||0))-Math.max(Math.abs(a.net5B||0),Math.abs(a.net3B||0)));
  state.hotMoneyHistory = { group, updatedAt: Date.now(), scanned:selected.length, ok, fail, rows: out, mode:'net-only-distinct-days' };
  state.debug.push({ stage:'net-bigmoney-3-5-ready', group, scanned:selected.length, ok, fail, rows:out.length, note:'فقط خالص پول درشت ۳/۵ روزه از ۳ و ۵ روز معاملاتی معتبر و متمایز محاسبه شد؛ اگر کمتر از ۵ روز معتبر باشد، ۵روزه نمایش داده نمی‌شود.' });
  await saveCache();
  renderAllTables(); renderHotMoneyStatus(); renderDebug();
  setStatus(`خالص پول درشت ۳/۵ روزه آماده شد: موفق ${fa(ok)} | ناموفق ${fa(fail)}`);
  if(btn) btn.disabled = false;
}
async function fetchHotMoneyForRow(row){
  const code = String(row.numericInsCode || row.insCode || '').trim();
  if(!/^\d{8,}$/.test(code)) return null;
  const daily = await fetchDailyMarketRecords(row);
  const historyDays = [];
  const seen = new Set();
  for(const d of [...daily].sort((a,b)=>Number(b.key)-Number(a.key))){
    if(!d || !d.key || seen.has(d.key)) continue;
    seen.add(d.key);
    historyDays.push(d);
    if(historyDays.length >= 18) break;
  }
  const dayStats = [];
  for(const d of historyDays){
    if(dayStats.length >= 5) break;
    try{
      const c = await fetchClientTypeForDay(code, d.key);
      if(!c || !(c.buyVolI || c.sellVolI || c.buyCountI || c.sellCountI)) continue;
      const price = Number(d.closePrice || row.closePrice || row.lastPrice || 0);
      const stat = calcHotFromClient(c, price, Number(d.valueB||0));
      dayStats.push({ key:d.key, label:d.label, ...stat });
    }catch(e){ /* skip invalid day */ }
  }
  const sum = (arr,k)=>arr.reduce((s,x)=>s+Number(x[k]||0),0);
  const d3 = dayStats.slice(0,3);
  const d5 = dayStats.slice(0,5);
  const net3B = globalThis.RadarFormulaEngine?.netWindow(dayStats, 3, 'hotB') ?? null;
  const net5B = globalThis.RadarFormulaEngine?.netWindow(dayStats, 5, 'hotB') ?? null;
  return {
    key: alertKey(row), symbol: row.symbol, fullName: row.fullName, group: row.assetGroup, boardUrl: row.boardUrl,
    okDays: dayStats.length,
    net3B, net5B,
    days3: d3.length, days5: d5.length,
    lastLabel: dayStats.map(x=>x.label).slice(0,5).join('، ')
  };
}
function renderBigMoney(){
  let rows = filteredBaseRows('bigSearchInput');
  const g = $('bigGroupSelect')?.value || 'all';
  if(g !== 'all') rows = rows.filter(x => x.assetGroup === g);
  rows.sort(sorter($('bigModeSelect').value));
  const body = $('bigRows'); if(!body) return;
  body.innerHTML = rows.length ? rows.slice(0,1200).map(x=>{
    const h = hotForRow(x);
    return `<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td>`+
      `<td><span class="badge">${esc(x.assetGroup||'')}</span></td>`+
      `<td class="${cls(x.bigMoneyB)}"><b>${moneyUnit(x.bigMoneyB)}</b><br><small>خرید درشت ${moneyUnit(x.bigBuyB)} / فروش درشت ${moneyUnit(x.bigSellB)} | خام کانال ${moneyUnit(x.smtRawNetB||0)}</small></td>`+
      `<td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td>`+
      hotMoneyCell(h)+
      `<td>${moneyUnit(x.buyAvgOrderB)}</td><td>${moneyUnit(x.sellAvgOrderB)}</td><td>${nf(x.buyPower)}×</td><td>${nf(x.sellPower)}×</td><td>${pct(x.gap)}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
  renderHotMoneyStatus();
}
function renderHotMoneyResultsTable(){
  const body = $('hotMoneyRows');
  const info = $('hotMoneySummary');
  if(!body) return;
  const hm = state.hotMoneyHistory;
  const activeGroup = $('bigGroupSelect')?.value || 'all';
  if(!hm || !Array.isArray(hm.rows) || !hm.rows.length){
    if(info) info.textContent = 'هنوز محاسبه نشده؛ گروه موردنظر را انتخاب کن و دکمه «خالص پول درشت ۳/۵ روزه» را بزن.';
    body.innerHTML = '<tr><td colspan="5" class="empty">نتیجه‌ای برای نمایش نیست.</td></tr>';
    return;
  }
  let rows = hm.rows || [];
  if(activeGroup !== 'all') rows = rows.filter(x => String(x.group||'') === String(activeGroup));
  const sumValid = (k)=>rows.reduce((s,x)=>s+(x[k] == null ? 0 : Number(x[k]||0)),0);
  const time = hm.updatedAt ? new Date(hm.updatedAt).toLocaleString('fa-IR') : '—';
  if(info) info.innerHTML = `نتیجه قابل نمایش: <b>${fa(rows.length)}</b> نماد | محدوده محاسبه: <b>${esc(hm.group==='all'?'کل بازار':hm.group)}</b> | خالص ۳روزه: <b class="${cls(sumValid('net3B'))}">${moneyUnit(sumValid('net3B'))}</b> | خالص ۵روزه: <b class="${cls(sumValid('net5B'))}">${moneyUnit(sumValid('net5B'))}</b> | بروزرسانی: ${time}`;
  const srt = rows.slice().sort((a,b)=>Math.max(Math.abs(b.net5B||0), Math.abs(b.net3B||0))-Math.max(Math.abs(a.net5B||0), Math.abs(a.net3B||0)));
  body.innerHTML = srt.length ? srt.map(h=>`<tr>`+
    `<td><b>${h.boardUrl?`<a href="${esc(h.boardUrl)}" target="_blank" rel="noopener">${esc(h.symbol||'')}</a>`:esc(h.symbol||'')}</b><br><small>${esc(h.fullName||'')}</small></td>`+
    `<td><span class="badge">${esc(h.group||'')}</span></td>`+
    `<td class="${cls(h.net3B)}"><b>${moneyMaybe(h.net3B)}</b></td>`+
    `<td class="${cls(h.net5B)}"><b>${moneyMaybe(h.net5B)}</b></td>`+
    `<td>${fa(h.okDays||0)}<br><small>${esc(h.lastLabel||'')}</small></td>`+
    `</tr>`).join('') : '<tr><td colspan="5" class="empty">برای فیلتر فعلی نتیجه‌ای نیست؛ گروه را عوض کن یا دوباره محاسبه بزن.</td></tr>';
}


/* ===== v day-trend patch: per-symbol all-day big-money trend ===== */
function trendDayKey(ts = Date.now()){
  try{ return new Date(ts).toISOString().slice(0,10); }catch(e){ return String(new Date().getDate()); }
}
function compactDayTrend(arr, max = 120){
  arr = (arr || []).filter(Boolean).sort((a,b)=>Number(a.t||0)-Number(b.t||0));
  if(arr.length <= max) return arr;
  const first = arr[0], last = arr[arr.length - 1];
  const body = arr.slice(1, -1);
  const keep = Math.max(1, max - 2);
  const step = Math.ceil(body.length / keep);
  const out = [first];
  for(let i=0; i<body.length && out.length < max-1; i += step) out.push(body[i]);
  if(out[out.length-1] !== last) out.push(last);
  return out.slice(-max);
}
function addSymbolBigTrend(rows){
  state.symbolBigTrend = state.symbolBigTrend && typeof state.symbolBigTrend === 'object' ? state.symbolBigTrend : {};
  const now = Date.now();
  const day = trendDayKey(now);
  const alive = new Set();
  const minGapMs = Math.max(30000, Math.min(120000, Number(getMonitorIntervalMs?.() || DEFAULT_MONITOR_INTERVAL_MS || 1000) * 12));
  for(const r of rows || []){
    const k = alertKey(r);
    if(!k) continue;
    alive.add(k);
    let arr = Array.isArray(state.symbolBigTrend[k]) ? state.symbolBigTrend[k] : [];
    arr = arr.filter(p => p && p.d === day);
    const last = arr[arr.length-1];
    const b = Number(r.bigMoneyB || 0), bb = Number(r.bigBuyB || 0), bs = Number(r.bigSellB || 0), rm = Number(r.realMoneyB || 0);
    const point = { t: now, d: day, b, bb, bs, r: rm };
    if(!last){
      arr.push(point);
    }else{
      const changed = Math.abs(Number(last.b||0)-b) > 0.0001 || Math.abs(Number(last.bb||0)-bb) > 0.0001 || Math.abs(Number(last.bs||0)-bs) > 0.0001;
      const strongMove = Math.abs(b - Number(last.b||0)) > Math.max(3, Math.abs(Number(last.b||0) || b) * 0.05);
      const enoughTime = now - Number(last.t||0) >= minGapMs;
      if(changed && (enoughTime || strongMove)) arr.push(point);
      else if(last){ last.t = now; last.b = b; last.bb = bb; last.bs = bs; last.r = rm; last.d = day; }
    }
    state.symbolBigTrend[k] = compactDayTrend(arr, 120);
  }
  for(const k of Object.keys(state.symbolBigTrend)){
    const arr = Array.isArray(state.symbolBigTrend[k]) ? state.symbolBigTrend[k].filter(p=>p && p.d === day) : [];
    if(!alive.has(k) || !arr.length) delete state.symbolBigTrend[k];
    else state.symbolBigTrend[k] = compactDayTrend(arr, 120);
  }
}

function addSnapshot(rows){
  const overall = summarizeRows(rows);
  const groups = {};
  for(const g of [...new Set((rows||[]).map(x=>x.assetGroup||'نامشخص'))]){
    groups[g] = summarizeRows((rows||[]).filter(x => (x.assetGroup||'نامشخص') === g));
  }
  const snap = { time: Date.now(), ...overall, groups };
  state.history = [...(state.history||[]), snap].slice(-240);
  addSymbolBigTrend(rows || []);
}

function ensureBigTrendHeader(){
  const tr = document.querySelector('#bigmoney thead tr');
  if(!tr || tr.querySelector('th[data-big-trend]')) return;
  const th = document.createElement('th');
  th.dataset.bigTrend = '1';
  th.textContent = 'روند روزانه پول درشت';
  tr.insertBefore(th, tr.children[3] || null);
}

function bigTrendForRow(row){
  const k = alertKey(row);
  const day = trendDayKey();
  const hist = (state.symbolBigTrend && state.symbolBigTrend[k]) ? state.symbolBigTrend[k] : [];
  return Array.isArray(hist) ? hist.filter(p=>p && p.d === day).sort((a,b)=>Number(a.t||0)-Number(b.t||0)) : [];
}
function bigTrendInfo(hist){
  if(!hist || hist.length < 2) return { score:0, label:'در حال شکل‌گیری', fullDelta:0, recentDelta:0, first:0, last:0, currentBig:0 };
  const first = Number(hist[0].b || 0);
  const last = Number(hist[hist.length-1].b || 0); // خالص فعلی پول درشت امروز؛ باید با ستون پول درشت امروز هم‌جهت باشد
  const idx = Math.max(0, hist.length - 1 - Math.max(3, Math.floor(hist.length * 0.25)));
  const recentStart = Number(hist[idx].b || 0);
  const deltaFromFirst = last - first;
  const recentDelta = last - recentStart;
  const vals = hist.map(x=>Number(x.b||0));
  const range = Math.max(1, Math.max(...vals) - Math.min(...vals));
  const netBase = Math.max(3, Math.abs(last)*0.02, range*0.05);
  const moveBase = Math.max(3, Math.abs(last)*0.015, range*0.08);
  let label = 'برآیند خنثی';
  if(last > netBase){
    if(recentDelta < -moveBase) label = 'برآیند مثبت؛ فشار اخیر خروجی';
    else if(recentDelta > moveBase) label = 'برآیند مثبت؛ ورود در حال تقویت';
    else label = 'برآیند مثبت؛ روند آرام';
  }else if(last < -netBase){
    if(recentDelta > moveBase) label = 'برآیند منفی؛ فشار اخیر ورودی';
    else if(recentDelta < -moveBase) label = 'برآیند منفی؛ خروج در حال تقویت';
    else label = 'برآیند منفی؛ روند آرام';
  }else{
    if(recentDelta > moveBase) label = 'خنثی؛ ورود اخیر بهتر شده';
    else if(recentDelta < -moveBase) label = 'خنثی؛ خروج اخیر بیشتر شده';
  }
  // score عمداً بر اساس خالص فعلی است، نه شیب اخیر؛ تا نماد مثبت با نمودار قرمز اشتباه نشود.
  return { score:last, label, fullDelta:deltaFromFirst, recentDelta, first, last, currentBig:last };
}
function timeShort(ts){
  try{ return new Date(ts).toLocaleTimeString('fa-IR', {hour:'2-digit', minute:'2-digit'}); }catch(e){ return ''; }
}
function miniBigTrendSpark(row){
  const hist = bigTrendForRow(row);
  if(hist.length < 2) return '<div class="sparkWrap muted"><small>برای روند روزانه، داشبورد را باز بگذار</small></div>';
  const w=190, h=54, padL=6, padR=6, padT=6, padB=12;
  const vals = hist.map(x=>Number(x.b||0));
  let min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  if(min === max){ min -= 1; max += 1; }
  const span = (max-min) || 1;
  const xLine = i => padL + i * ((w-padL-padR) / Math.max(1, vals.length-1));
  const yLine = v => padT + (h-padT-padB) - ((v-min)/span)*(h-padT-padB);
  const zeroY = yLine(0);
  const pts = vals.map((v,i)=>`${xLine(i).toFixed(1)},${yLine(v).toFixed(1)}`).join(' ');
  const info = bigTrendInfo(hist);
  const tone = cls(info.score);
  const stroke = info.score >= 0 ? '#22c55e' : '#ef4444';
  const startT = timeShort(hist[0].t), endT = timeShort(hist[hist.length-1].t);
  return `<div class="sparkWrap dayTrend" title="خط نمودار: خالص پول درشت همان نماد از اولین نقطه ثبت‌شده امروز تا اکنون. برای پوشش کامل از شروع بازار، داشبورد باید از ابتدای بازار باز باشد.">
    <svg class="bigSpark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="روند روزانه پول درشت">
      <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${w-padR}" y2="${zeroY.toFixed(1)}" stroke="#334155" stroke-width="1"/>
      <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${xLine(0).toFixed(1)}" cy="${yLine(vals[0]).toFixed(1)}" r="2.2" fill="#94a3b8"/>
      <circle cx="${xLine(vals.length-1).toFixed(1)}" cy="${yLine(vals[vals.length-1]).toFixed(1)}" r="2.8" fill="${stroke}"/>
      <text x="${padL}" y="${h-2}" fill="#94a3b8" font-size="8">${esc(startT)}</text>
      <text x="${w-padR-34}" y="${h-2}" fill="#94a3b8" font-size="8">${esc(endT)}</text>
    </svg>
    <small class="${tone}">${esc(info.label)} | فعلی: ${moneyUnit(info.currentBig)} | تغییر: ${moneyUnit(info.fullDelta)}</small>
  </div>`;
}

function renderBigMoney(){
  ensureBigTrendHeader();
  let rows = filteredBaseRows('bigSearchInput');
  const g = $('bigGroupSelect')?.value || 'all';
  if(g !== 'all') rows = rows.filter(x => x.assetGroup === g);
  rows.sort(sorter($('bigModeSelect').value));
  const body = $('bigRows'); if(!body) return;
  body.innerHTML = rows.length ? rows.slice(0,1200).map(x=>{
    const h = hotForRow(x);
    return `<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td>`+
      `<td><span class="badge">${esc(x.assetGroup||'')}</span></td>`+
      `<td class="${cls(x.bigMoneyB)}"><b>${moneyUnit(x.bigMoneyB)}</b><br><small>خرید درشت ${moneyUnit(x.bigBuyB)} / فروش درشت ${moneyUnit(x.bigSellB)} | خام کانال ${moneyUnit(x.smtRawNetB||0)}</small></td>`+
      `<td>${miniBigTrendSpark(x)}</td>`+
      `<td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td>`+
      hotMoneyCell(h)+
      `<td>${moneyUnit(x.buyAvgOrderB)}</td><td>${moneyUnit(x.sellAvgOrderB)}</td><td>${nf(x.buyPower)}×</td><td>${nf(x.sellPower)}×</td><td>${pct(x.gap)}</td></tr>`;
  }).join('') : '<tr><td colspan="13" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
  renderHotMoneyStatus();
}

function renderAllTables(){
  try{ ensureBigTrendHeader(); }catch(e){}
  if(typeof renderCards === 'function') renderCards();
  if(typeof renderLists === 'function') renderLists();
  if(typeof renderGroups === 'function') renderGroups();
  if(typeof renderSymbols === 'function') renderSymbols();
  if(typeof renderBigMoney === 'function') renderBigMoney();
  if(typeof renderBattle === 'function') renderBattle();
  if(typeof renderAlerts === 'function') renderAlerts();
  if(typeof renderHotMoneyResultsTable === 'function') renderHotMoneyResultsTable();
}


/* ===== v6.27 strict group override =====
   اولویت با کد صنعت معتبر TSE است. اگر کد صنعت تک‌رقمی/نامعتبر باشد یا با اسم نماد تضاد واضح داشته باشد،
   از تشخیص محافظه‌کارانه نام/نماد استفاده می‌شود تا خطاهایی مثل افتادن بانک در زراعت تکرار نشود.
*/
function officialIndustryFromCode(code){
  const c = pickIndustryCode([code]);
  return c && INDUSTRY_CODE_MAP[c] ? INDUSTRY_CODE_MAP[c] : '';
}
function isAgricultureText(txt){ return hasAny(norm(txt||''), ['زراعت','کشاورزی','كشاورزي','دامپروری','دامپروري','دامداری','دامداري']); }
function isStrongGuessGroup(g){ return g && g !== 'سایر/نامشخص'; }
function classifyAsset(r){
  const fund = instrumentClass(r);
  if(fund) return fund;
  const text = `${r.symbol||''} ${r.fullName||''}`;
  const official = officialIndustryFromCode(r.sectorCode);
  const guessed = guessIndustryFromName(text);
  if(!official) return guessed;
  if(official === 'سایر/نامشخص' && isStrongGuessGroup(guessed)) return guessed;
  if(official === 'زراعت و خدمات وابسته' && !isAgricultureText(text) && isStrongGuessGroup(guessed)) return guessed;
  // اگر نام نماد با یک صنعت شناخته‌شده خیلی واضح جور است، آن را به کد مشکوک ترجیح بده.
  if(isStrongGuessGroup(guessed) && guessed !== official){
    const t = norm(text);
    if(hasAny(t, ['بانک','بانك','اعتباری','اعتباري','وپاسار','وبملت','وتجارت','وبصادر','وپست','وسینا','وسينا','وخاور','ونوین','ونوين'])) return guessed;
    if(hasAny(t, ['خودرو','قطعات','خساپا','خگستر','خپارس','خاور','خبهمن','خزامیا','خزاميا'])) return guessed;
    if(hasAny(t, ['فولاد','فملی','فملي','فخوز','ذوب','فلزات','مس'])) return guessed;
    if(hasAny(t, ['پتروشیمی','پتروشيمي','شیمیایی','شيميايي'])) return guessed;
    if(hasAny(t, ['پالایش','پالايش','نفت'])) return guessed;
  }
  return official;
}

/* ===== v6.30 FINAL OFFICIAL TSE GROUPING OVERRIDE =====
   مشکل اصلی نسخه‌های قبلی: تلاش برای استخراج گروه صنعت از ستون‌های MarketWatchInit/Plus.
   آن ستون‌ها برای همه نمادها ثابت و قابل اتکا نبودند. در این نسخه گروه صنعت از endpoint رسمی خود TSETMC
   یعنی GetRelatedCompany/{CSecVal} ساخته می‌شود و با insCode/ISIN/نماد روی ردیف‌ها اعمال می‌شود.
*/
const OFFICIAL_GROUP_CACHE_KEY = STORAGE_KEY + '_officialRelatedCompanyGroups_v1';
const OFFICIAL_GROUP_CACHE_MS = 12 * 60 * 60 * 1000;
let officialRelatedGroupMap = null;
let officialRelatedGroupFetchedAt = 0;

function officialGroupKeyStats(map){
  if(!map) return { byIns:0, byIsin:0, bySymbol:0, codes:0 };
  return { byIns:map.byIns?.size||0, byIsin:map.byIsin?.size||0, bySymbol:map.bySymbol?.size||0, codes:map.codes?.length||0 };
}

async function ensureOfficialGroupMap(force=false){
  const now = Date.now();
  if(!force && officialRelatedGroupMap && (now - officialRelatedGroupFetchedAt) < OFFICIAL_GROUP_CACHE_MS) return officialRelatedGroupMap;
  try{
    if(!force){
      const cached = await chrome.storage.local.get([OFFICIAL_GROUP_CACHE_KEY]);
      const c = cached && cached[OFFICIAL_GROUP_CACHE_KEY];
      if(c && c.ts && (now - c.ts) < OFFICIAL_GROUP_CACHE_MS && Array.isArray(c.items) && c.items.length > 100){
        officialRelatedGroupMap = buildOfficialGroupMapFromItems(c.items);
        officialRelatedGroupFetchedAt = c.ts;
        state.debug.push({ stage:'official-group-cache', source:'chrome.storage', items:c.items.length, ...officialGroupKeyStats(officialRelatedGroupMap) });
        return officialRelatedGroupMap;
      }
    }
  }catch(e){ state.debug.push({ stage:'official-group-cache-error', message:e.message||String(e) }); }

  const items = [];
  const codes = Object.keys(INDUSTRY_CODE_MAP || {}).filter(c => /^\d{2}$/.test(c));
  let ok = 0, fail = 0;
  const batchSize = 6;
  for(let i=0; i<codes.length; i+=batchSize){
    const batch = codes.slice(i, i+batchSize);
    const results = await Promise.allSettled(batch.map(code => fetchOfficialGroupItems(code, INDUSTRY_CODE_MAP[code])));
    results.forEach((res, idx) => {
      const code = batch[idx];
      if(res.status === 'fulfilled'){
        ok++;
        items.push(...res.value);
      }else{
        fail++;
        if(fail <= 8) state.debug.push({ stage:'official-group-fetch-error', code, group:INDUSTRY_CODE_MAP[code], message:res.reason?.message || String(res.reason) });
      }
    });
  }
  officialRelatedGroupMap = buildOfficialGroupMapFromItems(items);
  officialRelatedGroupFetchedAt = now;
  state.debug.push({ stage:'official-group-built', source:'cdn.tsetmc.com/api/ClosingPrice/GetRelatedCompany/{CSecVal}', codes:codes.length, ok, fail, items:items.length, ...officialGroupKeyStats(officialRelatedGroupMap), note:'گروه صنعت از فهرست رسمی شرکت‌های هر صنعت در TSETMC ساخته شد؛ نه از حدس نام نماد.' });
  try{
    if(items.length > 100) await chrome.storage.local.set({ [OFFICIAL_GROUP_CACHE_KEY]: { ts: now, items } });
  }catch(e){ state.debug.push({ stage:'official-group-cache-save-error', message:e.message||String(e) }); }
  return officialRelatedGroupMap;
}

async function fetchOfficialGroupItems(code, name){
  const url = `https://cdn.tsetmc.com/api/ClosingPrice/GetRelatedCompany/${code}`;
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 6500);
  try{
    const res = await fetch(url, { cache:'no-store', credentials:'omit', signal:controller.signal, headers:{ Accept:'application/json,text/plain,*/*' } });
    const text = await res.text();
    if(!res.ok) throw new Error(`${res.status} ${text.slice(0,80)}`);
    if(!text.trim() || text.trim().startsWith('<')) throw new Error('empty/html response');
    const root = JSON.parse(text);
    let rows = [];
    if(Array.isArray(root)) rows = root;
    else{
      ['relatedCompany','relatedCompanyDto','closingPriceInfo','instrument','instruments','data','company','companies','marketwatch','marketWatch'].forEach(k => {
        if(Array.isArray(root[k])) rows.push(...root[k]);
      });
      rows.push(...extractRows(root));
    }
    const out = [];
    const seen = new Set();
    for(const o of rows){
      const item = normalizeOfficialGroupItem(o, code, name);
      if(!item) continue;
      const key = item.insCode || item.instrumentID || item.symbol;
      if(!key || seen.has(key)) continue;
      seen.add(key); out.push(item);
    }
    return out;
  }finally{ clearTimeout(timer); }
}

function normalizeOfficialGroupItem(o, code, name){
  if(!o || typeof o !== 'object') return null;
  const symbol = clean(String(val(o, ['lva','l18','lVal18AFC','LVal18AFC','symbol','namad','instrumentPersianCode','instrumentName','ticker']) || ''));
  const fullName = clean(String(val(o, ['lvc','l30','lVal30','LVal30','fullName','companyName','name','instrumentTitle']) || symbol));
  const insCode = String(val(o, ['insCode','InsCode','inscode','nscCode','code','instrumentCode']) || '').trim();
  const instrumentID = String(val(o, ['instrumentID','instrumentId','isin','isinCode','insID','cisin','CIsin','cIsin','cIsinVal']) || '').trim().toUpperCase();
  if(!insCode && !instrumentID && !symbol) return null;
  return { insCode, instrumentID, symbol, fullName, groupCode:code, groupName:name };
}

function buildOfficialGroupMapFromItems(items){
  const map = { byIns:new Map(), byIsin:new Map(), bySymbol:new Map(), codes:Object.keys(INDUSTRY_CODE_MAP||{}) };
  for(const it of items || []){
    const obj = { name:it.groupName, code:it.groupCode, source:'TSE-GetRelatedCompany' };
    if(it.insCode) map.byIns.set(String(it.insCode), obj);
    if(it.instrumentID) map.byIsin.set(String(it.instrumentID).toUpperCase(), obj);
    if(it.symbol) map.bySymbol.set(compactKey(it.symbol), obj);
  }
  return map;
}

function officialGroupForRow(r){
  const map = officialRelatedGroupMap;
  if(!map) return null;
  const byIns = String(r.numericInsCode || r.insCode || '').trim();
  if(byIns && map.byIns.has(byIns)) return map.byIns.get(byIns);
  const isin = String(r.instrumentID || '').trim().toUpperCase();
  if(isin && map.byIsin.has(isin)) return map.byIsin.get(isin);
  const sym = compactKey(r.symbol || '');
  if(sym && map.bySymbol.has(sym)) return map.bySymbol.get(sym);
  return null;
}

function marketTextInstrumentRows(text){
  const sections = String(text || '').split('@');
  const candidates = [];
  for(let si=0; si<sections.length; si++){
    const rows = sections[si].split(/[;\r\n]+/).map(x=>x.trim()).filter(Boolean);
    let score = 0;
    for(const row of rows){ if(looksLikeInstrumentRow(row)) score++; }
    if(score) candidates.push({ section:si, score, rows });
  }
  candidates.sort((a,b)=>b.score-a.score);
  if(candidates.length && candidates[0].score >= 20){
    state.debug.push({ stage:'market-text-section-selected', section:candidates[0].section, score:candidates[0].score, rows:candidates[0].rows.length, note:'فقط بخش واقعی فهرست نمادها از MarketWatchInit/Plus خوانده شد؛ بخش شاخص‌ها/خلاصه بازار کنار گذاشته شد.' });
    return candidates[0].rows.filter(looksLikeInstrumentRow);
  }
  const fallback = [];
  for(const part of String(text||'').split(/[;\r\n]+/)){
    const row = part.trim();
    if(looksLikeInstrumentRow(row)) fallback.push(row);
  }
  state.debug.push({ stage:'market-text-section-fallback', rows:fallback.length });
  return fallback;
}

function looksLikeInstrumentRow(row){
  if(!row || row.includes('<!doctype')) return false;
  const p = row.split(',').map(clean);
  if(p.length < 14) return false;
  if(!/^\d{5,}$/.test(p[0] || '')) return false;
  if(!p[1] || p[1].length < 4) return false;
  if(!p[2] || /@/.test(p[2]) || /^\d+(\.\d+)?$/.test(p[2])) return false;
  if(!p[3] || /^\d+(\.\d+)?$/.test(p[3])) return false;
  return true;
}

function parseMarketText(text, source){
  if(!text || text.trim().startsWith('<!doctype')) throw new Error('HTML shell response, not market data');
  const records = [];
  const rows = marketTextInstrumentRows(text);
  let recordErrors = 0;
  for(const raw0 of rows){
    try{
      const p = String(raw0 || '').split(',').map(clean);
      const numericInsCode = p[0];
      const insCode = numericInsCode;
      const instrumentID = p[1] || '';
      const symbol = p[2] || '';
      const fullName = p[3] || symbol;
      const rowKey = numericInsCode || instrumentID || compactKey(symbol);
      const closePrice = toNum(p[6]) || toNum(p[13]) || toNum(p[7]) || toNum(p[5]) || 0;
      const lastPrice = toNum(p[13]) || toNum(p[7]) || closePrice;
      const yesterday = toNum(p[7]) || toNum(p[4]) || 0;
      const item = {
        rowKey, insCode, numericInsCode, instrumentID, symbol, fullName,
        firstPrice: toNum(p[5]),
        closePrice,
        lastPrice,
        yesterday,
        tradeCount: toNum(p[8]),
        volume: toNum(p[9]),
        tradeValueRial: toNum(p[10]),
        priceMin: toNum(p[11]),
        priceMax: toNum(p[12]),
        baseVolume: toNum(p[15]),
        sectorCode: '',
        industryName: '',
        marketName: marketFromInstrument(instrumentID, source),
        source: `${source}|officialGroupPending`
      };
      item.lastPercent = pctChange(item.lastPrice, item.yesterday);
      item.closePercent = pctChange(item.closePrice, item.yesterday);
      if(Math.abs(item.lastPercent) > 80) item.lastPercent = 0;
      if(Math.abs(item.closePercent) > 80) item.closePercent = 0;
      if(isValidMarket(item)) records.push(item);
    }catch(e){
      recordErrors++;
      if(recordErrors <= 3) state.debug.push({ stage:'parse-record-error-v630', url:source, message:e.message || String(e), sample:String(raw0).slice(0,120) });
    }
  }
  state.debug.push({ stage:'parse-text-v630', url:source, rows:records.length, recordErrors, note:'در این نسخه از ستون‌های مشکوک MarketWatch برای صنعت استفاده نمی‌شود؛ صنعت بعداً از GetRelatedCompany رسمی وصل می‌شود.' });
  return records;
}

function officialIndustryFromCode(code){
  const c = pickIndustryCode([code]);
  return c && INDUSTRY_CODE_MAP[c] ? INDUSTRY_CODE_MAP[c] : '';
}
function isStrongGuessGroup(g){ return g && g !== 'سایر/نامشخص'; }
function classifyAsset(r){
  const fund = instrumentClass(r);
  if(fund) return fund;
  const off = officialGroupForRow(r);
  if(off && off.name) return off.name;
  const official = officialIndustryFromCode(r.sectorCode);
  if(official) return official;
  return guessIndustryFromName(`${r.symbol||''} ${r.fullName||''}`);
}
function finalizeMarketMeta(r){
  const fundGroup = instrumentClass(r);
  const off = !fundGroup ? officialGroupForRow(r) : null;
  const code = pickIndustryCode([off?.code, r.sectorCode]);
  const industryName = fundGroup || (off && off.name) || (code ? industryFromCode(code, '') : industryFromCode('', `${r.symbol||''} ${r.fullName||''}`));
  const groupSource = fundGroup ? 'fund-classifier' : (off ? 'TSE-GetRelatedCompany' : (code ? 'industry-code' : 'name-fallback'));
  return { ...r, sectorCode: code || r.sectorCode || '', industryName, assetGroup: industryName, groupSource, marketName: fundGroup ? 'صندوق قابل معامله سهامی' : marketFromInstrument(r.instrumentID, r.source || r.marketName || '') };
}

function rollSessionV710(session){
  if(!session) return;
  if(state.sessionDate !== session.dateKey){
    // A new Tehran trading date must never inherit yesterday's cumulative client counters.
    state.sessionDate = session.dateKey;
    state.sessionTradingObserved = false;
    state.marketPhase = session.phase;
    state.alerts = [];
    state.history = [];
    state.symbolBigTrend = {};
    state.bigMoneyFlow = { date:session.dateKey, symbols:{} };
    state.rows = [];
    state.clientRows = 0;
    state.lastUpdated = null;
  }else{
    state.marketPhase = session.phase;
  }
}

async function refresh(opts={}){
  const session = globalThis.RadarMarketSession?.current?.() || null;
  rollSessionV710(session);
  setMonitorBadge(!!autoTimer);

  // Time-of-day restriction removed. Only non-trading days are blocked;
  // regular trading days may refresh before 09:00 and after 12:30 as requested.
  if(session && session.phase === 'closed-day'){
    state.rows = [];
    state.clientRows = 0;
    state.lastUpdated = null;
    state.dataQuality = { sessionBlocked:true, phase:session.phase };
    if(!opts.fromAuto){
      await saveCache();
      setStatus(`${globalThis.RadarMarketSession.phaseLabel(session.phase)}؛ روز غیرمعاملاتی است.`);
      renderAll();
    }
    return;
  }
  if(opts.fromAuto && session && !globalThis.RadarMarketSession?.canGenerateAlerts?.(session)){
    // Non-trading days may still stop automatic polling; clock-time limits are disabled.
    setMonitorBadge(true);
    return;
  }

  if(isRefreshing){
    if(!opts.fromAuto) setStatus('یک دریافت هنوز در حال اجراست؛ چند لحظه بعد دوباره تلاش کن.');
    return;
  }
  isRefreshing = true;
  const sameSessionRows = state.sessionDate === session?.dateKey ? state.rows : [];
  const prevRows = (sameSessionRows && state.lastUpdated && (Date.now() - state.lastUpdated < 10*60*1000)) ? sameSessionRows : [];
  state.debug = [];
  setStatus(opts.fromAuto ? 'پایش خودکار فعال است...' : 'در حال دریافت داده...', false);
  const rb = $('refreshBtn'); if(rb) rb.disabled = true;
  try{
    const market = await fetchMarket();
    const marketFreshness = globalThis.RadarMarketSession?.assessMarket?.(market, session) || { observed:true };
    if(marketFreshness.observed) state.sessionTradingObserved = true;
    await ensureOfficialGroupMap(false);
    const clients = await fetchClients();
    const sessionCtx = { session, marketFreshness, sessionTradingObserved:!!state.sessionTradingObserved };
    const newRows = buildRows(market, clients, sessionCtx);
    applyBigMoneySnapshotFormulaV811(newRows, session?.dateKey, Date.now());
    const officialCount = newRows.filter(x=>x.groupSource === 'TSE-GetRelatedCompany').length;
    state.dataQuality = {
      ...assessDataQuality(newRows, clients, market),
      officialGroupMatched: officialCount,
      officialGroupCoverage: newRows.length ? officialCount / newRows.length : 0,
      sessionPhase:session?.phase || 'unknown',
      sessionDate:session?.dateKey || '',
      sessionTradingObserved:!!state.sessionTradingObserved,
      marketFreshness
    };
    const allowAlerts = !!(session && globalThis.RadarMarketSession?.canGenerateAlerts?.(session) && state.sessionTradingObserved);
    const newAlerts = allowAlerts ? detectInstantAlerts(prevRows, newRows) : [];
    state.rows = newRows;
    state.clientRows = clients.size;
    state.lastUpdated = Date.now();
    if(newAlerts.length) addAlerts(newAlerts);
    if(allowAlerts) addSnapshot(state.rows);
    await saveCache();
    const liveRows = newRows.filter(x=>x.liveSessionData).length;
    const phaseText = globalThis.RadarMarketSession?.phaseLabel?.(session?.phase) || 'بازار';
    setStatus(`به‌روزرسانی شد: ${fa(newRows.length)} نماد | زنده ${fa(liveRows)} | ${phaseText} | ${new Date(state.lastUpdated).toLocaleTimeString('fa-IR')}`);
  }catch(e){
    state.debug.push({ stage:'final-error-v710', message:e.message || String(e) });
    setStatus(v83FailureMessage(e), true);
  }finally{
    isRefreshing = false;
    const rb2 = $('refreshBtn'); if(rb2) rb2.disabled = false;
    renderAll();
  }
}

function renderReport(){
  const rows = state.rows || [];
  const val = sum(rows, x=>x.valueB);
  const real = sum(rows, x=>x.realMoneyB);
  const big = sum(rows, x=>x.bigMoneyB);
  $('mTotal').textContent = fa(rows.length);
  $('mClient').textContent = fa(state.clientRows || 0);
  $('mValue').textContent = moneyUnit(val);
  setTextClass('mRealMoney', moneyUnit(real), cls(real));
  setTextClass('mBigMoney', moneyUnit(big), cls(big));
  if($('mPercent')) $('mPercent').textContent = `${pct(weightedAvg(rows,x=>x.lastPercent,x=>x.valueB||1))} / ${pct(weightedAvg(rows,x=>x.closePercent,x=>x.valueB||1))}`;
  if($('mBattle')) $('mBattle').textContent = `${fa(rows.filter(x=>x.gap>0).length)} خرید / ${fa(rows.filter(x=>x.gap<0).length)} فروش`;
  const ogc = state.dataQuality?.officialGroupCoverage ? pct(state.dataQuality.officialGroupCoverage*100) : '۰٪';
  $('dataHealth').innerHTML = `<b>وضعیت:</b> ${rows.length ? 'به‌روز' : 'بدون داده'} | <b>نمادها:</b> ${fa(rows.length)} | <b>حقیقی/حقوقی:</b> ${pct((state.dataQuality?.clientCoverage||0)*100)} | <b>بروزرسانی:</b> ${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString('fa-IR') : '—'}`;
  mini('topBigIn', rows.filter(x=>x.bigMoneyB>0).sort((a,b)=>b.bigMoneyB-a.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`سرانه خرید ${moneyUnit(x.buyAvgOrderB)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topBigOut', rows.filter(x=>x.bigMoneyB<0).sort((a,b)=>a.bigMoneyB-b.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`سرانه فروش ${moneyUnit(x.sellAvgOrderB)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topRealIn', rows.filter(x=>x.realMoneyB>0).sort((a,b)=>b.realMoneyB-a.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت خرید ${nf(x.buyPower)}×`);
  mini('topRealOut', rows.filter(x=>x.realMoneyB<0).sort((a,b)=>a.realMoneyB-b.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت فروش ${nf(x.sellPower)}×`);
  mini('topBattleBuy', rows.filter(x=>x.gap>0).sort((a,b)=>b.gap-a.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)} | ${x.battle.label}`);
  mini('topBattleSell', rows.filter(x=>x.gap<0).sort((a,b)=>a.gap-b.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)} | ${x.battle.label}`);
  updateAllGroupSelects(rows);
}

/* ===== v6.31 PRICE + GROUP AUDIT OVERRIDE =====
   Fix root cause: MarketWatchInit fields were mixed up. Correct short layout:
   p5 first, p6 close, p7 yesterday, p8 trade count, p9 volume, p10 value,
   p11 min, p12 max, p13 last, p14 EPS. MarketWatchPlus long layout is parsed
   with its own indexes and CSecVal from p8. Only real instrument section is used.
*/
try{
  const dailyAll = 'https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyAllInst';
  if(Array.isArray(MARKET_JSON_URLS) && !MARKET_JSON_URLS.includes(dailyAll)) MARKET_JSON_URLS.unshift(dailyAll);
}catch(_e){}

function isLikelyIsinV631(x){
  const s = String(x || '').trim().toUpperCase();
  return /^IR[A-Z0-9]{6,}$/.test(s) || /^IRO[0-9A-Z]{6,}$/.test(s) || /^IRR[0-9A-Z]{6,}$/.test(s) || /^IRT[0-9A-Z]{6,}$/.test(s);
}
function isBadSymbolV631(x){
  const s = compactKey(String(x || ''));
  return !s || ['تابلو','بازار','بورس','فرابورس','شاخص','ارزشبازار'].includes(s) || /^\d+$/.test(s);
}
function looksLikeInstrumentRow(row){
  if(!row || row.includes('<!doctype') || row.includes('<html')) return false;
  const p = String(row).split(',').map(clean);
  if(p.length < 15) return false;
  if(!/^\d{8,}$/.test(p[0] || '')) return false;
  if(!isLikelyIsinV631(p[1])) return false;
  if(isBadSymbolV631(p[2])) return false;
  if(!p[3] || /^\d+(\.\d+)?$/.test(p[3]) || /<[^>]+>/.test(p[3])) return false;
  const nums = [p[5],p[6],p[7],p[8],p[9],p[10],p[11],p[12],p[13]].map(toNum);
  const numScore = nums.filter(n => Number.isFinite(n) && n > 0).length;
  return numScore >= 4;
}
function marketTextInstrumentRows(text){
  const sections = String(text || '').split('@');
  const candidates = [];
  for(let si=0; si<sections.length; si++){
    const rows = sections[si].split(/[;\r\n]+/).map(x=>x.trim()).filter(Boolean);
    const good = rows.filter(looksLikeInstrumentRow);
    if(good.length) candidates.push({ section:si, score:good.length, rows:good });
  }
  candidates.sort((a,b)=>b.score-a.score);
  if(candidates.length){
    const chosen = candidates[0];
    state.debug.push({ stage:'market-text-section-selected-v631', section:chosen.section, rows:chosen.rows.length, note:'فقط بخش واقعی نمادها خوانده شد؛ بخش شاخص/پیام/سفارش کنار گذاشته شد.' });
    return chosen.rows;
  }
  const fallback = [];
  for(const part of String(text||'').split(/[;\r\n]+/)){
    const row = part.trim();
    if(looksLikeInstrumentRow(row)) fallback.push(row);
  }
  state.debug.push({ stage:'market-text-section-fallback-v631', rows:fallback.length });
  return fallback;
}
function sanePctV631(a,b){
  if(!a || !b) return false;
  const p = pctChange(a,b);
  return Number.isFinite(p) && Math.abs(p) <= 35;
}
function chooseYesterdayV631(lastPrice, closePrice, candidates){
  const cleanCandidates = candidates.map(toNum).filter(x => Number.isFinite(x) && x > 0);
  for(const y of cleanCandidates){
    if(sanePctV631(lastPrice,y) && sanePctV631(closePrice,y)) return y;
  }
  for(const y of cleanCandidates){
    if(sanePctV631(closePrice,y) || sanePctV631(lastPrice,y)) return y;
  }
  return cleanCandidates[0] || 0;
}
function parseTextInstrumentRowV631(p, source){
  const numericInsCode = p[0];
  const insCode = numericInsCode;
  const instrumentID = String(p[1] || '').trim().toUpperCase();
  const symbol = p[2] || '';
  const fullName = p[3] || symbol;
  const rowKey = numericInsCode || instrumentID || compactKey(symbol);
  const isLongPlus = p.length >= 100 && (toNum(p[83]) || toNum(p[89]) || toNum(p[99]));
  let item;
  if(isLongPlus){
    const lastPrice = toNum(p[89]) || toNum(p[83]) || toNum(p[81]) || toNum(p[4]);
    const closePrice = toNum(p[83]) || toNum(p[89]) || toNum(p[4]);
    const yesterday = chooseYesterdayV631(lastPrice, closePrice, [p[4], p[7], p[83], p[89]]);
    const sectorCode = pickIndustryCode([p[8]]);
    item = {
      rowKey, insCode, numericInsCode, instrumentID, symbol, fullName,
      firstPrice: toNum(p[81]), closePrice, lastPrice, yesterday,
      tradeCount: toNum(p[95]), volume: toNum(p[97]), tradeValueRial: toNum(p[99]),
      priceMin: toNum(p[101]) || toNum(p[10]), priceMax: toNum(p[103]) || toNum(p[9]),
      baseVolume: toNum(p[5]), sectorCode,
      industryName: industryFromCode(sectorCode, `${symbol} ${fullName}`),
      marketName: marketFromInstrument(instrumentID, source),
      source: `${source}|MarketWatchPlus-long|cs:${sectorCode || 'NA'}`
    };
  }else{
    // MarketWatchInit short layout, confirmed by common parser: 5 first, 6 close, 7 yesterday, 13 last.
    const lastPrice = toNum(p[13]) || toNum(p[6]) || toNum(p[5]) || toNum(p[7]);
    const closePrice = toNum(p[6]) || toNum(p[13]) || toNum(p[5]) || toNum(p[7]);
    const yesterday = chooseYesterdayV631(lastPrice, closePrice, [p[7], p[4], p[6], p[13]]);
    const sectorCode = pickIndustryCode([p[18], p[15], p[16], p[17]]);
    item = {
      rowKey, insCode, numericInsCode, instrumentID, symbol, fullName,
      firstPrice: toNum(p[5]), closePrice, lastPrice, yesterday,
      tradeCount: toNum(p[8]), volume: toNum(p[9]), tradeValueRial: toNum(p[10]),
      priceMin: toNum(p[11]), priceMax: toNum(p[12]),
      baseVolume: toNum(p[15]), sectorCode,
      industryName: industryFromCode(sectorCode, `${symbol} ${fullName}`),
      marketName: marketFromInstrument(instrumentID, source),
      source: `${source}|MarketWatchInit-short|cs:${sectorCode || 'pending'}`
    };
  }
  item.lastPercent = pctChange(item.lastPrice, item.yesterday);
  item.closePercent = pctChange(item.closePrice, item.yesterday);
  if(Math.abs(item.lastPercent) > 35) item.lastPercent = 0;
  if(Math.abs(item.closePercent) > 35) item.closePercent = 0;
  return item;
}
function parseMarketText(text, source){
  if(!text || text.trim().startsWith('<!doctype')) throw new Error('HTML shell response, not market data');
  const records = [];
  const rows = marketTextInstrumentRows(text);
  let recordErrors = 0, longRows = 0, shortRows = 0, suspectPct = 0;
  for(const raw0 of rows){
    try{
      const p = String(raw0 || '').split(',').map(clean);
      const item = parseTextInstrumentRowV631(p, source);
      if((item.source||'').includes('long')) longRows++; else shortRows++;
      if(Math.abs(item.lastPercent||0) > 20 || Math.abs(item.closePercent||0) > 20) suspectPct++;
      if(isValidMarket(item)) records.push(item);
    }catch(e){
      recordErrors++;
      if(recordErrors <= 5) state.debug.push({ stage:'parse-record-error-v631', url:source, message:e.message || String(e), sample:String(raw0).slice(0,160) });
    }
  }
  state.debug.push({ stage:'parse-text-v631-price-audit', url:source, rows:records.length, shortRows, longRows, suspectPct, recordErrors, note:'قیمت پایانی/آخرین با ایندکس‌های درست MarketWatchInit/Plus خوانده شد؛ فقط ردیف نماد واقعی قبول شد.' });
  return records;
}
function rowQuality(r){
  const p = ((r.lastPrice||0)>0?2:0) + ((r.closePrice||0)>0?2:0) + ((r.yesterday||0)>0?2:0);
  const pctOk = (Math.abs(r.lastPercent||0) <= 35 && Math.abs(r.closePercent||0) <= 35) ? 3 : -5;
  return (r.numericInsCode?8:0) + (r.instrumentID?4:0) + p + ((r.tradeValueRial||0)>0?2:0) + (r.sectorCode?4:0) + pctOk;
}
async function fetchMarket(){
  const jsonRows = [];
  const textRows = [];
  for(const url of MARKET_JSON_URLS){
    try{
      const text = await fetchWithInfo(url, 6500);
      const rows = parseMarketJson(text, short(url));
      jsonRows.push(...rows);
      state.debug.push({ stage:'parse-json-v631', url:short(url), rows:rows.length, totalJson:jsonRows.length });
    }catch(e){ state.debug.push({ stage:'json-error-v631', url:short(url), message:e.name==='AbortError'?'timeout':(e.message||String(e)) }); }
  }
  let gotInit = false, gotPlus = false;
  for(const url of MARKET_TEXT_URLS){
    const isInit = /MarketWatchInit/i.test(url), isPlus = /MarketWatchPlus/i.test(url);
    if(isInit && gotInit) continue;
    if(isPlus && gotPlus) continue;
    try{
      const text = await fetchWithInfo(url, isInit ? 9000 : 11000);
      const rows = parseMarketText(text, short(url));
      if(rows.length){
        textRows.push(...rows);
        if(isInit && rows.length > 50) gotInit = true;
        if(isPlus && rows.length > 50) gotPlus = true;
      }
      state.debug.push({ stage:'parse-text-v631', url:short(url), rows:rows.length, totalText:textRows.length, gotInit, gotPlus });
      if(gotInit && gotPlus) break;
    }catch(e){ state.debug.push({ stage:'text-error-v631', url:short(url), message:e.name==='AbortError'?'timeout':(e.message||String(e)) }); }
  }
  const merged = mergeMarketRows(jsonRows, textRows);
  if(merged.length > 20){
    state.source = `${jsonRows.length?'cdn-json':''}${jsonRows.length&&textRows.length?'+':''}${textRows.length?'old-meta':''}` || 'market-merged';
    state.debug.push({ stage:'market-selected-v631', source:state.source, jsonRows:jsonRows.length, textRows:textRows.length, mergedRows:merged.length, gotInit, gotPlus, note:'برای قیمت، چیدمان فیلدها ممیزی شد؛ برای گروه، اگر Plus کد صنعت بدهد یا نقشه رسمی موجود باشد استفاده می‌شود.' });
    return merged;
  }
  if(jsonRows.length){ state.source='cdn-json-only'; return dedupeMarketRows(jsonRows); }
  if(textRows.length){ state.source='old-text-only'; return dedupeMarketRows(textRows); }
  throw new Error('هیچ داده بازار قابل پردازش دریافت نشد');
}


/* ===== v6.33 FINAL PRICE LIGHT OVERRIDE =====
   هدف: حذف کامل بخش سنگین حمایت/مقاومت و اصلاح ریشه‌ای قیمت‌ها.
   قانون قیمت:
   1) اولویت مطلق با ClosingPriceDailyAllInst رسمی CDN برای قیمت آخرین/پایانی/دیروز/حجم/ارزش.
   2) MarketWatchInit/Plus فقط برای نماد، نام، ISIN و بکاپ قیمت استفاده می‌شود.
   3) MarketWatchPlus دیگر با ایندکس‌های بلند و حدسی خوانده نمی‌شود؛ 15 ستون اول آن مانند MarketWatchInit خوانده می‌شود.
*/
var V633_DAILY_ALL_URL = 'https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyAllInst';
var V633_TEXT_URLS = [
  'https://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0',
  'http://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0',
  'https://old.tsetmc.com/tsev2/data/MarketWatchPlus.aspx?h=0&r=0',
  'http://old.tsetmc.com/tsev2/data/MarketWatchPlus.aspx?h=0&r=0'
];
var V633_MARKET_JSON_URLS = [
  'https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch?market=0&industrialGroup=',
  'https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch?market=1&industrialGroup='
];

function fieldAnyV633(o, names){
  if(!o || typeof o !== 'object') return undefined;
  for(const n of names){ if(o[n] !== undefined && o[n] !== null) return o[n]; }
  const lower = {};
  for(const k of Object.keys(o)) lower[k.toLowerCase()] = o[k];
  for(const n of names){ const v = lower[String(n).toLowerCase()]; if(v !== undefined && v !== null) return v; }
  return undefined;
}
function isReasonablePriceSetV633(lastPrice, closePrice, yesterday){
  const lp = Number(lastPrice||0), cp = Number(closePrice||0), yp = Number(yesterday||0);
  if(lp <= 0 && cp <= 0) return false;
  if(yp > 0){
    const a = lp>0 ? Math.abs(pctChange(lp,yp)) : 0;
    const b = cp>0 ? Math.abs(pctChange(cp,yp)) : 0;
    if(a > 40 || b > 40) return false;
  }
  return true;
}
function collectObjectsV633(root){
  const out = [], seen = new Set();
  const walk = v => {
    if(!v) return;
    if(Array.isArray(v)){ v.forEach(walk); return; }
    if(typeof v === 'object'){
      const hasIns = fieldAnyV633(v, ['insCode','InsCode','inscode','instrumentID','instrumentId','insID','id']);
      const hasPrice = fieldAnyV633(v, ['pClosing','PClosing','pDrCotVal','PDrCotVal','priceYesterday','PriceYesterday','qTotCap','QTotCap','pl','pc','py']);
      if(hasIns !== undefined && hasPrice !== undefined){
        const key = String(hasIns) + ':' + JSON.stringify(v).slice(0,80);
        if(!seen.has(key)){ seen.add(key); out.push(v); }
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(root);
  return out;
}
function normalizeDailyPriceV633(o){
  const insCode = String(fieldAnyV633(o, ['insCode','InsCode','inscode','instrumentID','instrumentId','insID','id']) || '').trim();
  if(!/^\d{5,}$/.test(insCode)) return null;
  const closePrice = toNum(fieldAnyV633(o, ['pClosing','PClosing','closingPrice','ClosingPrice','pc','PC','pcl','PCL']));
  const lastPrice = toNum(fieldAnyV633(o, ['pDrCotVal','PDrCotVal','lastPrice','LastPrice','pl','PL','pdv','PDV']));
  const yesterday = toNum(fieldAnyV633(o, ['priceYesterday','PriceYesterday','pYesterday','PYesterday','py','PY']));
  const volume = toNum(fieldAnyV633(o, ['qTotTran5J','QTotTran5J','volume','Volume','tvol','qtj']));
  const tradeValueRial = toNum(fieldAnyV633(o, ['qTotCap','QTotCap','tradeValue','TradeValue','value','Value','tval','qtc']));
  const tradeCount = toNum(fieldAnyV633(o, ['zTotTran','ZTotTran','tradeCount','TradeCount','tno','ztt']));
  const firstPrice = toNum(fieldAnyV633(o, ['priceFirst','PriceFirst','firstPrice','FirstPrice','pf','PF']));
  const priceMin = toNum(fieldAnyV633(o, ['priceMin','PriceMin','pmin','PriceMinToday']));
  const priceMax = toNum(fieldAnyV633(o, ['priceMax','PriceMax','pmax','PriceMaxToday']));
  if(!isReasonablePriceSetV633(lastPrice, closePrice, yesterday) && !tradeValueRial && !volume) return null;
  return { insCode, numericInsCode:insCode, lastPrice, closePrice, yesterday, volume, tradeValueRial, tradeCount, firstPrice, priceMin, priceMax, priceSource:'ClosingPriceDailyAllInst' };
}
function parseDailyAllPriceMapV633(text, source){
  const t = String(text||'').trim();
  if(!t || t.startsWith('<')) throw new Error('daily all response is not JSON');
  const root = JSON.parse(t);
  let raw = [];
  ['closingPriceDaily','closingPriceDailyAll','closingPriceDailyAllInst','data','items','result'].forEach(k=>{ if(Array.isArray(root?.[k])) raw = raw.concat(root[k]); });
  if(Array.isArray(root)) raw = raw.concat(root);
  if(!raw.length) raw = collectObjectsV633(root);
  const map = new Map();
  let ok=0, bad=0;
  for(const o of raw){
    const n = normalizeDailyPriceV633(o);
    if(n && n.insCode){ map.set(String(n.insCode), n); ok++; } else bad++;
  }
  state.debug.push({ stage:'parse-daily-all-v633', url:source, raw:raw.length, ok, bad, note:'قیمت رسمی امروز: PDrCotVal=آخرین، PClosing=پایانی، PriceYesterday=دیروز' });
  return map;
}
async function fetchDailyPriceMapV633(){
  try{
    const text = await fetchWithInfo(V633_DAILY_ALL_URL, 9000);
    return parseDailyAllPriceMapV633(text, short(V633_DAILY_ALL_URL));
  }catch(e){
    state.debug.push({ stage:'daily-all-error-v633', url:short(V633_DAILY_ALL_URL), message:e.name==='AbortError'?'timeout':(e.message||String(e)) });
    return new Map();
  }
}
function parseTextInstrumentRowV633(p, source){
  const numericInsCode = String(p[0] || '').trim();
  const instrumentID = String(p[1] || '').trim().toUpperCase();
  const symbol = p[2] || '';
  const fullName = p[3] || symbol;
  const lastPrice = toNum(p[13]);       // آخرین معامله در MarketWatchInit
  const closePrice = toNum(p[6]);       // قیمت پایانی در MarketWatchInit
  const yesterday = toNum(p[7]);        // دیروز
  const item = {
    rowKey:numericInsCode || instrumentID || compactKey(symbol),
    insCode:numericInsCode,
    numericInsCode,
    instrumentID,
    symbol,
    fullName,
    firstPrice:toNum(p[5]),
    closePrice,
    lastPrice,
    yesterday,
    tradeCount:toNum(p[8]),
    volume:toNum(p[9]),
    tradeValueRial:toNum(p[10]),
    priceMin:toNum(p[11]),
    priceMax:toNum(p[12]),
    baseVolume:toNum(p[15]),
    sectorCode:pickIndustryCode([p[18], p[17], p[16], p[15]]),
    industryName:'',
    marketName:marketFromInstrument(instrumentID, source),
    priceSource:'MarketWatchInit/Plus',
    source:`${source}|text15`
  };
  if(!isReasonablePriceSetV633(item.lastPrice, item.closePrice, item.yesterday)){
    // قیمت مشکوک را صفر می‌کنیم تا فقط DailyAll یا فیلد معتبر جایگزین شود.
    item.lastPrice = 0; item.closePrice = 0; item.yesterday = 0;
  }
  item.lastPercent = pctChange(item.lastPrice, item.yesterday);
  item.closePercent = pctChange(item.closePrice, item.yesterday);
  if(Math.abs(item.lastPercent) > 40) item.lastPercent = 0;
  if(Math.abs(item.closePercent) > 40) item.closePercent = 0;
  return item;
}
function parseMarketText(text, source){
  if(!text || String(text).trim().startsWith('<!doctype')) throw new Error('HTML shell response, not market data');
  const records = [];
  const rows = marketTextInstrumentRows(text);
  let recordErrors = 0, suspectPrice = 0;
  for(const raw0 of rows){
    try{
      const p = String(raw0 || '').split(',').map(clean);
      const item = parseTextInstrumentRowV633(p, source);
      if(!item.lastPrice || !item.closePrice) suspectPrice++;
      if(isValidMarket(item)) records.push(item);
    }catch(e){
      recordErrors++;
      if(recordErrors <= 5) state.debug.push({ stage:'parse-record-error-v633', url:source, message:e.message || String(e), sample:String(raw0).slice(0,180) });
    }
  }
  state.debug.push({ stage:'parse-text-v633', url:source, rows:records.length, suspectPrice, recordErrors, note:'MarketWatch فقط با چیدمان ۱۵ ستون اول خوانده شد؛ ایندکس‌های بلند حذف شدند.' });
  return records;
}
function overlayDailyPriceV633(row, price){
  if(!price) return row;
  const out = { ...row };
  ['lastPrice','closePrice','yesterday','volume','tradeValueRial','tradeCount','firstPrice','priceMin','priceMax'].forEach(k=>{
    if(Number(price[k]||0) > 0 || ['volume','tradeValueRial','tradeCount'].includes(k)) out[k] = Number(price[k]||0);
  });
  out.priceSource = 'ClosingPriceDailyAllInst';
  out.source = `${row.source || ''}|price:daily-all`;
  out.lastPercent = pctChange(out.lastPrice, out.yesterday);
  out.closePercent = pctChange(out.closePrice, out.yesterday);
  if(Math.abs(out.lastPercent) > 40) out.lastPercent = 0;
  if(Math.abs(out.closePercent) > 40) out.closePercent = 0;
  return out;
}
function normalizeMarket(o){
  const symbol = clean(String(fieldAnyV633(o, ['lva','l18','lVal18AFC','LVal18AFC','symbol','shortName','namad']) || ''));
  const fullName = clean(String(fieldAnyV633(o, ['lvc','l30','lVal30','LVal30','fullName','companyName','name']) || symbol));
  const instrumentID = String(fieldAnyV633(o,['instrumentID','instrumentId','insID','InsID','isin','isinCode']) || '').trim().toUpperCase();
  const numericIns = String(fieldAnyV633(o, ['insCode','InsCode','inscode','nscCode','code']) || '').trim();
  const rowKey = numericIns || instrumentID || `json:${symbol}:${fullName}:${o._idx||0}`;
  const insCode = numericIns || instrumentID || rowKey;
  const yesterday = toNum(fieldAnyV633(o, ['priceYesterday','PriceYesterday','pYesterday','py','PY','yesterday']));
  const lastPrice = toNum(fieldAnyV633(o, ['pDrCotVal','PDrCotVal','pdv','PDV','lastPrice','last','pl','PL','price']));
  const closePrice = toNum(fieldAnyV633(o, ['pClosing','PClosing','pcl','PCL','pc','PC','closingPrice','close','finalPrice']));
  const volume = toNum(fieldAnyV633(o, ['qTotTran5J','QTotTran5J','totalVolume','volume','tvol','qtj']));
  const tradeValueRial = toNum(fieldAnyV633(o, ['qTotCap','QTotCap','totalValue','tradeValue','value','tval','qtc']));
  const tradeCount = toNum(fieldAnyV633(o, ['zTotTran','ZTotTran','tradeCount','count','tno','ztt']));
  const sectorCode = pickIndustryCode([fieldAnyV633(o, ['cSecVal','CSecVal','sectorCode','sector','group','cs','csv'])]);
  const industryName = clean(String(fieldAnyV633(o, ['industryName','sectorName','csName','groupName']) || industryFromCode(sectorCode, fullName)));
  const item = { rowKey, insCode, numericInsCode:numericIns, instrumentID, symbol, fullName, lastPrice, closePrice, yesterday, volume, tradeValueRial, tradeCount, sectorCode, industryName, marketName: marketFromInstrument(instrumentID, String(o._source || '')), source:o._source || '', priceSource:'json' };
  item.lastPercent = pctChange(item.lastPrice, item.yesterday);
  item.closePercent = pctChange(item.closePrice, item.yesterday);
  if(Math.abs(item.lastPercent)>40) item.lastPercent = 0;
  if(Math.abs(item.closePercent)>40) item.closePercent = 0;
  return item;
}
async function fetchMarket(){
  const dailyMap = await fetchDailyPriceMapV633();
  const textRows = [];
  let gotInit = false, gotPlus = false;
  for(const url of V633_TEXT_URLS){
    const isInit = /MarketWatchInit/i.test(url), isPlus = /MarketWatchPlus/i.test(url);
    if(isInit && gotInit) continue;
    if(isPlus && gotPlus) continue;
    try{
      const text = await fetchWithInfo(url, isInit ? 9000 : 11000);
      const rows = parseMarketText(text, short(url));
      if(rows.length){
        textRows.push(...rows);
        if(isInit && rows.length > 50) gotInit = true;
        if(isPlus && rows.length > 50) gotPlus = true;
      }
      state.debug.push({ stage:'parse-text-source-v633', url:short(url), rows:rows.length, totalText:textRows.length, gotInit, gotPlus });
      if(gotInit && gotPlus) break;
    }catch(e){ state.debug.push({ stage:'text-error-v633', url:short(url), message:e.name==='AbortError'?'timeout':(e.message||String(e)) }); }
  }
  let rows = dedupeMarketRows(textRows).map(r => overlayDailyPriceV633(r, dailyMap.get(String(r.numericInsCode || r.insCode || ''))));
  if(rows.length > 20){
    state.source = dailyMap.size ? 'old-market-text+official-daily-prices' : 'old-market-text-price-fallback';
    state.debug.push({ stage:'market-selected-v633', textRows:textRows.length, dailyPriceRows:dailyMap.size, mergedRows:rows.length, gotInit, gotPlus, priceAudit:'DailyAll رسمی روی MarketWatch اعمال شد؛ قیمت‌ها باید با TSETMC هم‌خوان شوند.' });
    return rows;
  }
  const jsonRows = [];
  for(const url of V633_MARKET_JSON_URLS){
    try{
      const text = await fetchWithInfo(url, 6500);
      const parsed = parseMarketJson(text, short(url));
      jsonRows.push(...parsed.map(r => overlayDailyPriceV633(r, dailyMap.get(String(r.numericInsCode || r.insCode || '')))));
      state.debug.push({ stage:'parse-json-fallback-v633', url:short(url), rows:parsed.length, totalJson:jsonRows.length });
    }catch(e){ state.debug.push({ stage:'json-error-v633', url:short(url), message:e.name==='AbortError'?'timeout':(e.message||String(e)) }); }
  }
  rows = dedupeMarketRows(jsonRows);
  if(rows.length > 20){ state.source = dailyMap.size ? 'json+official-daily-prices' : 'json-price-fallback'; return rows; }
  throw new Error('هیچ داده بازار قابل پردازش دریافت نشد');
}
function priceRial(n){
  const v = Number(n || 0);
  return v > 0 ? `${fa(Math.round(v).toLocaleString('en-US'))} ریال` : '—';
}
function symbolTr(x){
  return `<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td>`+
  `<td><span class="badge">${esc(x.assetGroup||'نامشخص')}</span><br><small>${esc(x.marketName||'')} | ${x.traded ? 'معامله‌شده' : 'بدون معامله/متوقف'} | قیمت: ${esc(x.priceSource||'—')}</small></td>`+
  `<td class="numCell">${priceRial(x.lastPrice)}</td><td class="numCell">${priceRial(x.closePrice)}</td>`+
  `<td class="${cls(x.lastPercent)}">${pct(x.lastPercent)}</td><td class="${cls(x.closePercent)}">${pct(x.closePercent)}</td>`+
  `<td><span class="badge battleBadge ${x.battle.tone}">${esc(x.battle.label)}</span><br><small class="${cls(x.gap)}">${pct(x.gap)}</small></td>`+
  `<td class="${cls(x.bigMoneyB)}"><b>${moneyUnit(x.bigMoneyB)}</b></td><td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td>`+
  `<td>خرید: ${moneyUnit(x.buyAvgOrderB)}<br><small>فروش: ${moneyUnit(x.sellAvgOrderB)}</small></td><td>${nf(x.buyPower)}× / ${nf(x.sellPower)}×</td><td>${moneyUnit(x.valueB)}</td></tr>`;
}
function renderSymbols(){
  let rows = filteredBaseRows('searchInput');
  const g = $('groupSelect')?.value || 'all'; if(g !== 'all') rows = rows.filter(x => x.assetGroup === g);
  const s = $('sortSelect')?.value || 'bigIn';
  rows.sort(sorter(s));
  const body = $('symbolRows'); if(!body) return;
  body.innerHTML = rows.length ? rows.slice(0,1200).map(symbolTr).join('') : '<tr><td colspan="12" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
}
function renderReport(){
  const rows = state.rows || [];
  const val = sum(rows, x=>x.valueB);
  const real = sum(rows, x=>x.realMoneyB);
  const big = sum(rows, x=>x.bigMoneyB);
  $('mTotal').textContent = fa(rows.length);
  $('mClient').textContent = fa(state.clientRows || 0);
  $('mValue').textContent = moneyUnit(val);
  setTextClass('mRealMoney', moneyUnit(real), cls(real));
  setTextClass('mBigMoney', moneyUnit(big), cls(big));
  if($('mPercent')) $('mPercent').textContent = `${pct(weightedAvg(rows,x=>x.lastPercent,x=>x.valueB||1))} / ${pct(weightedAvg(rows,x=>x.closePercent,x=>x.valueB||1))}`;
  if($('mBattle')) $('mBattle').textContent = `${fa(rows.filter(x=>x.gap>0).length)} خرید / ${fa(rows.filter(x=>x.gap<0).length)} فروش`;
  const ogc = state.dataQuality?.officialGroupCoverage ? pct(state.dataQuality.officialGroupCoverage*100) : '۰٪';
  const dailyPriceCount = rows.filter(x=>x.priceSource === 'ClosingPriceDailyAllInst').length;
  $('dataHealth').innerHTML = `<b>وضعیت:</b> ${rows.length ? 'به‌روز' : 'بدون داده'} | <b>نمادها:</b> ${fa(rows.length)} | <b>حقیقی/حقوقی:</b> ${pct((state.dataQuality?.clientCoverage||0)*100)} | <b>بروزرسانی:</b> ${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString('fa-IR') : '—'}`;
  mini('topBigIn', rows.filter(x=>x.bigMoneyB>0).sort((a,b)=>b.bigMoneyB-a.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`آخرین ${priceRial(x.lastPrice)} | پایانی ${priceRial(x.closePrice)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topBigOut', rows.filter(x=>x.bigMoneyB<0).sort((a,b)=>a.bigMoneyB-b.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`آخرین ${priceRial(x.lastPrice)} | پایانی ${priceRial(x.closePrice)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topRealIn', rows.filter(x=>x.realMoneyB>0).sort((a,b)=>b.realMoneyB-a.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت خرید ${nf(x.buyPower)}×`);
  mini('topRealOut', rows.filter(x=>x.realMoneyB<0).sort((a,b)=>a.realMoneyB-b.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت فروش ${nf(x.sellPower)}×`);
  mini('topBattleBuy', rows.filter(x=>x.gap>0).sort((a,b)=>b.gap-a.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${priceRial(x.lastPrice)} (${pct(x.lastPercent)}) | پایانی ${priceRial(x.closePrice)} (${pct(x.closePercent)})`);
  mini('topBattleSell', rows.filter(x=>x.gap<0).sort((a,b)=>a.gap-b.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${priceRial(x.lastPrice)} (${pct(x.lastPercent)}) | پایانی ${priceRial(x.closePrice)} (${pct(x.closePercent)})`);
  updateAllGroupSelects(rows);
}


/* ===== v6.34 LIVE PRICE AUDIT OVERRIDE =====
   اصلاح نهایی قیمت:
   - DailyAll دیگر روی قیمت لحظه‌ای اولویت ندارد، چون می‌تواند با تابلوی لحظه‌ای اختلاف زمانی داشته باشد.
   - منبع قیمت زنده: GetMarketWatch اگر داده بدهد، وگرنه MarketWatchInit/Plus.
   - در JSON بازار: pdv=آخرین، pmd=پایانی، pc و pcpc تغییر ریالی هستند نه قیمت.
   - در متن MarketWatchInit: p6=پایانی، p7=آخرین، p13/p4=دیروز.
*/
/* ===== v8.3 DATA SOURCE FIX =====
   GetMarketWatch expects the full paperTypes set on the current CDN API.
   The older v8.2 request only sent paperTypes 1 and 2; on some responses this
   can produce an empty/partial universe.  Build the official bulk URL with
   paperTypes 1..9, hEven=0 and RefID=0.  Keep the simple URL as a last fallback.
*/
function v83MarketWatchUrl(market, showTraded){
  const q = new URLSearchParams();
  q.set('market', String(market));
  q.set('industrialGroup', '');
  for(let i=0;i<9;i++) q.append(`paperTypes[${i}]`, String(i+1));
  q.set('withBestLimits','false');
  q.set('hEven','0');
  q.set('RefID','0');
  q.set('showTraded', showTraded ? 'true' : 'false');
  return `https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch?${q.toString()}`;
}
var V634_MARKET_JSON_URLS = [
  v83MarketWatchUrl(0,false),
  v83MarketWatchUrl(1,false),
  v83MarketWatchUrl(0,true),
  v83MarketWatchUrl(1,true),
  'https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch?market=0&industrialGroup=',
  'https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch?market=1&industrialGroup='
];
var V634_TEXT_URLS = [
  'https://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0',
  'http://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0',
  'https://old.tsetmc.com/tsev2/data/MarketWatchPlus.aspx?h=0&r=0',
  'http://old.tsetmc.com/tsev2/data/MarketWatchPlus.aspx?h=0&r=0'
];
function nV634(x){ return toNum(x); }
function anyV634(o, names){ return fieldAnyV633(o, names); }
function priceYesterdayFromChangesV634(lastPrice, closePrice, dLast, dClose){
  const lp = Number(lastPrice||0), cp = Number(closePrice||0), dl = Number(dLast||0), dc = Number(dClose||0);
  const cands = [];
  if(cp > 0 && dc !== 0) cands.push(cp - dc);
  if(lp > 0 && dl !== 0) cands.push(lp - dl);
  for(const v of cands){ if(v > 0 && Math.abs(pctChange(cp || lp, v)) < 35) return v; }
  for(const v of cands){ if(v > 0) return v; }
  return 0;
}
function normalizeMarket(o){
  const symbol = clean(String(anyV634(o, ['lva','l18','lVal18AFC','LVal18AFC','symbol','shortName','namad']) || ''));
  const fullName = clean(String(anyV634(o, ['lvc','l30','lVal30','LVal30','fullName','companyName','name']) || symbol));
  const instrumentID = String(anyV634(o,['instrumentID','instrumentId','insID','InsID','isin','isinCode']) || '').trim().toUpperCase();
  const numericIns = String(anyV634(o, ['insCode','InsCode','inscode','nscCode','code']) || '').trim();
  const rowKey = numericIns || instrumentID || `json:${symbol}:${fullName}:${o._idx||0}`;
  const insCode = numericIns || instrumentID || rowKey;

  const pdv = nV634(anyV634(o, ['pdv','PDV','pDrCotVal','PDrCotVal','lastPrice','LastPrice','pl','PL']));
  const pmd = nV634(anyV634(o, ['pmd','PMD','pClosing','PClosing','closingPrice','ClosingPrice','pcl','PCL']));
  const changeClose = nV634(anyV634(o, ['pc','PC']));
  const changeLast = nV634(anyV634(o, ['pcpc','PCPC','pcc','PCC']));
  const explicitY = nV634(anyV634(o, ['py','PY','priceYesterday','PriceYesterday','pYesterday','PYesterday','yesterday']));
  const lastPrice = pdv || pmd;
  const closePrice = pmd || pdv;
  const yesterday = explicitY || priceYesterdayFromChangesV634(lastPrice, closePrice, changeLast, changeClose);

  const volume = nV634(anyV634(o, ['qtj','QTJ','qTotTran5J','QTotTran5J','totalVolume','volume','tvol']));
  const tradeValueRial = nV634(anyV634(o, ['qtc','QTC','qTotCap','QTotCap','totalValue','tradeValue','value','tval']));
  const tradeCount = nV634(anyV634(o, ['ztt','ZTT','zTotTran','ZTotTran','tradeCount','count','tno']));
  const priceMin = nV634(anyV634(o, ['pmn','PMN','priceMin','PriceMin','pmin']));
  const priceMax = nV634(anyV634(o, ['pmx','PMX','priceMax','PriceMax','pmax']));
  const firstPrice = nV634(anyV634(o, ['pmo','PMO','priceFirst','PriceFirst','firstPrice','pf','PF']));
  const hEven = nV634(anyV634(o, ['hEven','heven','HEven','lastHEven']));
  const dEven = String(anyV634(o, ['dEven','deven','DEven','finalLastDate']) || '').replace(/\D/g,'').slice(0,8);
  const sectorCode = pickIndustryCode([anyV634(o, ['cSecVal','CSecVal','sectorCode','sector','group','cs','csv'])]);
  const industryName = clean(String(anyV634(o, ['industryName','sectorName','csName','groupName']) || industryFromCode(sectorCode, fullName)));
  const item = { rowKey, insCode, numericInsCode:numericIns, instrumentID, symbol, fullName, lastPrice, closePrice, yesterday, volume, tradeValueRial, tradeCount, firstPrice, priceMin, priceMax, hEven, dEven, sectorCode, industryName, marketName: marketFromInstrument(instrumentID, String(o._source || '')), source:o._source || '', priceSource:'GetMarketWatch-live' };
  item.lastPercent = pctChange(item.lastPrice, item.yesterday);
  item.closePercent = pctChange(item.closePrice, item.yesterday);
  if(Math.abs(item.lastPercent)>35) item.lastPercent = 0;
  if(Math.abs(item.closePercent)>35) item.closePercent = 0;
  return item;
}
function parseTextInstrumentRowV634(p, source){
  const numericInsCode = String(p[0] || '').trim();
  const instrumentID = String(p[1] || '').trim().toUpperCase();
  const symbol = p[2] || '';
  const fullName = p[3] || symbol;
  const closePrice = nV634(p[6]);       // پایانی
  const lastPrice = nV634(p[7]);        // آخرین معامله
  const yesterday = nV634(p[13]) || nV634(p[4]);
  const item = {
    rowKey:numericInsCode || instrumentID || compactKey(symbol),
    insCode:numericInsCode, numericInsCode, instrumentID, symbol, fullName,
    hEven:nV634(p[4]), dEven:'',
    firstPrice:nV634(p[5]), closePrice, lastPrice, yesterday,
    tradeCount:nV634(p[8]), volume:nV634(p[9]), tradeValueRial:nV634(p[10]),
    priceMin:nV634(p[11]), priceMax:nV634(p[12]), baseVolume:nV634(p[15]),
    sectorCode:pickIndustryCode([p[18]]), industryName:'',
    marketName:marketFromInstrument(instrumentID, source),
    priceSource:'MarketWatch-text-live', source:`${source}|text-live-p6-p7`
  };
  item.lastPercent = pctChange(item.lastPrice, item.yesterday);
  item.closePercent = pctChange(item.closePrice, item.yesterday);
  if(Math.abs(item.lastPercent)>35) item.lastPercent = 0;
  if(Math.abs(item.closePercent)>35) item.closePercent = 0;
  return item;
}
function parseMarketText(text, source){
  if(!text || String(text).trim().startsWith('<!doctype')) throw new Error('HTML shell response, not market data');
  const records = [];
  const rows = marketTextInstrumentRows(text);
  let recordErrors = 0, suspectPrice = 0;
  for(const raw0 of rows){
    try{
      const p = String(raw0 || '').split(',').map(clean);
      if(p.length < 14) continue;
      const item = parseTextInstrumentRowV634(p, source);
      if(!item.lastPrice || !item.closePrice || Math.abs(item.lastPercent)>20 || Math.abs(item.closePercent)>20) suspectPrice++;
      if(isValidMarket(item)) records.push(item);
    }catch(e){
      recordErrors++;
      if(recordErrors <= 5) state.debug.push({ stage:'parse-record-error-v634', url:source, message:e.message || String(e), sample:String(raw0).slice(0,180) });
    }
  }
  state.debug.push({ stage:'parse-text-v634', url:source, rows:records.length, suspectPrice, recordErrors, note:'قیمت متن: p6 پایانی، p7 آخرین، p13/p4 دیروز؛ p13 دیگر آخرین فرض نمی‌شود.' });
  return records;
}
function mergeLiveMarketWithTextV634(jsonRows, textRows){
  if(jsonRows.length){
    const merged = mergeMarketRows(jsonRows, textRows).map(r => {
      const out = { ...r };
      if(out.priceSource !== 'GetMarketWatch-live' && out.source && String(out.source).includes('GetMarketWatch')) out.priceSource = 'GetMarketWatch-live';
      out.lastPercent = pctChange(out.lastPrice, out.yesterday);
      out.closePercent = pctChange(out.closePrice, out.yesterday);
      if(Math.abs(out.lastPercent)>35) out.lastPercent = 0;
      if(Math.abs(out.closePercent)>35) out.closePercent = 0;
      return out;
    });
    return dedupeMarketRows(merged);
  }
  return dedupeMarketRows(textRows);
}
async function fetchMarket(){
  const jsonRows = [];
  for(const url of V634_MARKET_JSON_URLS){
    try{
      const text = await fetchWithInfo(url, 8000);
      const parsed = parseMarketJson(text, short(url));
      jsonRows.push(...parsed);
      state.debug.push({ stage:'parse-json-live-v634', url:short(url), rows:parsed.length, totalJson:jsonRows.length, note:'GetMarketWatch زنده: pdv آخرین، pmd پایانی؛ pc/pcpc تغییر قیمت هستند.' });
      if(jsonRows.length > 200) break;
    }catch(e){ state.debug.push({ stage:'json-live-error-v634', url:short(url), message:e.name==='AbortError'?'timeout':(e.message||String(e)) }); }
  }

  const textRows = [];
  let gotInit = false, gotPlus = false;
  for(const url of V634_TEXT_URLS){
    const isInit = /MarketWatchInit/i.test(url), isPlus = /MarketWatchPlus/i.test(url);
    if(isInit && gotInit) continue;
    if(isPlus && gotPlus) continue;
    try{
      const text = await fetchWithInfo(url, isInit ? 9000 : 11000);
      const rows = parseMarketText(text, short(url));
      if(rows.length){
        textRows.push(...rows);
        if(isInit && rows.length > 50) gotInit = true;
        if(isPlus && rows.length > 50) gotPlus = true;
      }
      state.debug.push({ stage:'parse-text-source-v634', url:short(url), rows:rows.length, totalText:textRows.length, gotInit, gotPlus });
      if(gotInit && gotPlus && jsonRows.length > 200) break;
    }catch(e){ state.debug.push({ stage:'text-error-v634', url:short(url), message:e.name==='AbortError'?'timeout':(e.message||String(e)) }); }
  }

  const rows = mergeLiveMarketWithTextV634(jsonRows, textRows);
  const liveCount = rows.filter(x => x.priceSource === 'GetMarketWatch-live').length;
  const textCount = rows.filter(x => x.priceSource === 'MarketWatch-text-live').length;
  const badPct = rows.filter(x => Math.abs(x.lastPercent||0)>12 || Math.abs(x.closePercent||0)>12).length;
  state.debug.push({ stage:'market-selected-v634', jsonRows:jsonRows.length, textRows:textRows.length, mergedRows:rows.length, livePriceRows:liveCount, textPriceRows:textCount, suspectPctRows:badPct, priceAudit:'DailyAll حذف شد؛ قیمت زنده از GetMarketWatch و بکاپ از MarketWatchInit/Plus خوانده می‌شود.' });
  if(rows.length > 20){
    state.source = liveCount ? 'live-getmarketwatch+old-meta' : 'old-marketwatch-text-live-price';
    return rows;
  }
  throw new Error('هیچ داده بازار قابل پردازش دریافت نشد');
}
function makeAlert(time, type, r, dBig, dReal, dVal, dVol){
  const isBuy = type === 'bigBuy' || type === 'realBuy';
  const isBig = type === 'bigBuy' || type === 'bigSell';
  const amountB = isBig ? dBig : dReal;
  const side = isBuy ? 'خرید' : 'فروش';
  const kind = isBig ? 'پول درشت' : 'پول حقیقی';
  return {
    id: `${time}-${alertKey(r)}-${type}-${Math.round(amountB*1000)}`, key: alertKey(r), time, type, symbol:r.symbol, fullName:r.fullName, group:r.assetGroup, boardUrl:r.boardUrl,
    title: `${side} ${kind} لحظه‌ای ${r.symbol}`, amountB, dBig, dReal, dVal, dVol,
    cumulativeBigMoneyB: Number(r.bigMoneyB || 0), cumulativeBigBuyB: Number(r.bigBuyB || 0), cumulativeBigSellB: Number(r.bigSellB || 0), cumulativeRealMoneyB: Number(r.realMoneyB || 0), cumulativeValueB: Number(r.valueB || 0),
    buyPower: r.buyPower, sellPower: r.sellPower, lastPrice:r.lastPrice, closePrice:r.closePrice, yesterday:r.yesterday, lastPercent:r.lastPercent, closePercent:r.closePercent, gap:r.gap, priceSource:r.priceSource
  };
}
function renderReport(){
  const rows = state.rows || [];
  const val = sum(rows, x=>x.valueB);
  const real = sum(rows, x=>x.realMoneyB);
  const big = sum(rows, x=>x.bigMoneyB);
  $('mTotal').textContent = fa(rows.length);
  $('mClient').textContent = fa(state.clientRows || 0);
  $('mValue').textContent = moneyUnit(val);
  setTextClass('mRealMoney', moneyUnit(real), cls(real));
  setTextClass('mBigMoney', moneyUnit(big), cls(big));
  if($('mPercent')) $('mPercent').textContent = `${pct(weightedAvg(rows,x=>x.lastPercent,x=>x.valueB||1))} / ${pct(weightedAvg(rows,x=>x.closePercent,x=>x.valueB||1))}`;
  if($('mBattle')) $('mBattle').textContent = `${fa(rows.filter(x=>x.gap>0).length)} خرید / ${fa(rows.filter(x=>x.gap<0).length)} فروش`;
  const ogc = state.dataQuality?.officialGroupCoverage ? pct(state.dataQuality.officialGroupCoverage*100) : '۰٪';
  const livePriceCount = rows.filter(x=>x.priceSource === 'GetMarketWatch-live').length;
  const textPriceCount = rows.filter(x=>x.priceSource === 'MarketWatch-text-live').length;
  $('dataHealth').innerHTML = `<b>وضعیت:</b> ${rows.length ? 'به‌روز' : 'بدون داده'} | <b>نمادها:</b> ${fa(rows.length)} | <b>حقیقی/حقوقی:</b> ${pct((state.dataQuality?.clientCoverage||0)*100)} | <b>بروزرسانی:</b> ${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString('fa-IR') : '—'}`;
  mini('topBigIn', rows.filter(x=>x.bigMoneyB>0).sort((a,b)=>b.bigMoneyB-a.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`آخرین ${priceRial(x.lastPrice)} | پایانی ${priceRial(x.closePrice)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topBigOut', rows.filter(x=>x.bigMoneyB<0).sort((a,b)=>a.bigMoneyB-b.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`آخرین ${priceRial(x.lastPrice)} | پایانی ${priceRial(x.closePrice)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topRealIn', rows.filter(x=>x.realMoneyB>0).sort((a,b)=>b.realMoneyB-a.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت خرید ${nf(x.buyPower)}×`);
  mini('topRealOut', rows.filter(x=>x.realMoneyB<0).sort((a,b)=>a.realMoneyB-b.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت فروش ${nf(x.sellPower)}×`);
  mini('topBattleBuy', rows.filter(x=>x.gap>0).sort((a,b)=>b.gap-a.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${priceRial(x.lastPrice)} (${pct(x.lastPercent)}) | پایانی ${priceRial(x.closePrice)} (${pct(x.closePercent)})`);
  mini('topBattleSell', rows.filter(x=>x.gap<0).sort((a,b)=>a.gap-b.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${priceRial(x.lastPrice)} (${pct(x.lastPercent)}) | پایانی ${priceRial(x.closePrice)} (${pct(x.closePercent)})`);
  updateAllGroupSelects(rows);
}


/* === v6.48 FINAL OVERRIDE: PRICE GAP + REAL MONEY CLIENTTYPE FIX ===
   مشکل اصلی نسخه 6.37 این بود که در CSV قدیمی ClientTypeAll ترتیب ستون‌ها با فرض قبلی یکی نبود؛
   در نتیجه تعداد فروشنده به جای حجم خرید یا برعکس خوانده می‌شد و پول حقیقی عددهای غیرواقعی می‌داد.
   این وصله دو چیدمان شناخته‌شده را نگه می‌دارد و هنگام ساخت ردیف، با حجم کل معامله، چیدمان درست را انتخاب می‌کند.
   همچنین درصد «آخرین قوی‌تر از پایانی» از این به بعد اختلاف مستقیم آخرین/پایانی است، نه تفاضل دو درصد نسبت به دیروز.
*/
function anyV648(o, keys){
  for(const k of keys){ if(o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; }
  return undefined;
}
function nV648(v){ return toNum(v); }
function makeClientV648(insCode, buyCountI, buyCountN, sellCountI, sellCountN, buyVolI, buyVolN, sellVolI, sellVolN, buyValI=0, sellValI=0, tag=''){
  return {
    insCode:String(insCode||'').trim(),
    buyCountI:nV648(buyCountI), buyCountN:nV648(buyCountN), sellCountI:nV648(sellCountI), sellCountN:nV648(sellCountN),
    buyVolI:nV648(buyVolI), buyVolN:nV648(buyVolN), sellVolI:nV648(sellVolI), sellVolN:nV648(sellVolN),
    buyValI:nV648(buyValI), sellValI:nV648(sellValI), _clientLayout:tag
  };
}
function parseClientCsv(text){
  if(!text || String(text).trim().startsWith('<')) return [];
  // Documented old ClientTypeAll schema:
  // insCode,buyCountI,buyCountN,buyVolI,buyVolN,sellCountI,sellCountN,sellVolI,sellVolN
  // No heuristic column swapping: a wrong layout must fail validation instead of fabricating money flow.
  return String(text).split(/[;\r\n]+/).map(x=>x.trim()).filter(Boolean).map(line => {
    const p = line.split(',').map(clean);
    return makeClientV648(p[0], p[1], p[2], p[5], p[6], p[3], p[4], p[7], p[8], 0, 0, 'csv:documented-clienttypeall');
  }).filter(x=>x.insCode);
}

function normClient(v){
  const c = globalThis.RadarFormulaEngine?.normalizeClient(v) || {};
  return {
    ...c,
    buyValI:Number(c.buyValueI||0), sellValI:Number(c.sellValueI||0),
    _clientLayout:'json:formula-engine'
  };
}
function clientSideTotalsV648(c){
  return {
    buyTotalVol: Number(c.buyVolI||0) + Number(c.buyVolN||0),
    sellTotalVol: Number(c.sellVolI||0) + Number(c.sellVolN||0)
  };
}
function clientCandidateScoreV648(c, marketVolume){
  const v = Number(marketVolume || 0);
  const t = clientSideTotalsV648(c);
  let score = 0;
  if(v > 0){
    score += Math.abs(t.buyTotalVol - v) / Math.max(1, v);
    score += Math.abs(t.sellTotalVol - v) / Math.max(1, v);
    if(t.buyTotalVol <= 0 || t.sellTotalVol <= 0) score += 10;
    if(t.buyTotalVol > v * 2.5 || t.sellTotalVol > v * 2.5) score += 10;
  }
  // حجم باید معمولاً خیلی بزرگ‌تر از تعداد کدها باشد. اگر تعداد از حجم بزرگ‌تر شد، چیدمان مشکوک است.
  if(Number(c.buyVolI||0) > 0 && Number(c.buyCountI||0) > Number(c.buyVolI||0)) score += 2;
  if(Number(c.sellVolI||0) > 0 && Number(c.sellCountI||0) > Number(c.sellVolI||0)) score += 2;
  if(Number(c.buyCountI||0) <= 0 && Number(c.buyVolI||0) > 0) score += 1;
  if(Number(c.sellCountI||0) <= 0 && Number(c.sellVolI||0) > 0) score += 1;
  return score;
}
function selectClientForMarketV648(c, marketVolume){
  if(!c) return {};
  const candidates = Array.isArray(c._candidates) && c._candidates.length ? c._candidates : [c];
  let best = candidates[0], bestScore = clientCandidateScoreV648(best, marketVolume);
  for(const cand of candidates.slice(1)){
    const s = clientCandidateScoreV648(cand, marketVolume);
    if(s < bestScore){ best = cand; bestScore = s; }
  }
  return { ...best, _clientScore:bestScore };
}
function clientVolumeConsistencyV710(c, marketVolume){
  const v = Number(marketVolume || 0);
  if(v <= 0) return { ok:false, mismatch:Infinity, reason:'no-current-market-volume' };
  const buyTotal = Number(c?.buyVolI||0) + Number(c?.buyVolN||0);
  const sellTotal = Number(c?.sellVolI||0) + Number(c?.sellVolN||0);
  if(buyTotal <= 0 || sellTotal <= 0) return { ok:false, mismatch:Infinity, reason:'empty-client-volume' };
  const mb = Math.abs(buyTotal-v) / Math.max(1,v);
  const ms = Math.abs(sellTotal-v) / Math.max(1,v);
  const mismatch = Math.max(mb, ms);
  // Bulk endpoints can be a little asynchronous; 15% allows normal lag but rejects stale/wrong-layout rows.
  return { ok:mismatch <= 0.15, mismatch, buyTotal, sellTotal, reason:mismatch <= 0.15?'ok':'client-market-volume-mismatch' };
}
function totalValueBillionRialV648(m){
  const val = Number(m?.tradeValueRial || 0);
  if(val > 0) return val / 1e9;
  const vol = Number(m?.volume || 0);
  const price = Number(m?.closePrice || m?.lastPrice || m?.yesterday || 0);
  return (vol > 0 && price > 0) ? (vol * price / 1e9) : 0;
}
function clientSideValueBillionRialV648(totalValueB, indVol, legalVol, fallbackValueRial, fallbackPrice){
  const direct = Number(fallbackValueRial || 0);
  if(direct > 0) return direct / 1e9;
  const i = Number(indVol || 0), n = Number(legalVol || 0), total = i + n;
  if(totalValueB > 0 && total > 0) return totalValueB * (i / total);
  const price = Number(fallbackPrice || 0);
  return (i > 0 && price > 0) ? i * price / 1e9 : 0;
}
function priceGapPercentV648(lastPrice, closePrice){
  const last = Number(lastPrice || 0), close = Number(closePrice || 0);
  if(!(last > 0 && close > 0)) return 0;
  return ((last - close) / close) * 100;
}

function priceBattleGapPercentV651(m){
  // "آخرین قوی‌تر/ضعیف‌تر از پایانی" باید اختلاف دو درصد تابلو باشد:
  // درصد آخرین نسبت به دیروز منهای درصد پایانی نسبت به دیروز.
  // نسبت مستقیم قیمت آخرین به قیمت پایانی می‌تواند برای حق‌تقدم/صندوق/نمادهای خاص عددهای غیرواقعی مثل ۲۰٪ تا ۱۲۰٪ بسازد.
  const lp = Number(m?.lastPercent);
  const cp = Number(m?.closePercent);
  if(Number.isFinite(lp) && Number.isFinite(cp) && Math.abs(lp) <= 35 && Math.abs(cp) <= 35){
    return lp - cp;
  }
  const last = Number(m?.lastPrice || 0);
  const close = Number(m?.closePrice || 0);
  const y = Number(m?.yesterday || 0);
  if(last > 0 && close > 0 && y > 0){
    const lpp = pctChange(last, y);
    const cpp = pctChange(close, y);
    if(Number.isFinite(lpp) && Number.isFinite(cpp) && Math.abs(lpp) <= 35 && Math.abs(cpp) <= 35){
      return lpp - cpp;
    }
  }
  return 0;
}
function isNumberSuffixedSymbolV648(symbol){
  const s = compactKey(symbol || '');
  // نمادهایی مثل فشکر3/سیستم3 معمولاً نماد اصلی سهم نیستند و برای رادار پول و قیمت لحظه‌ای خطا ایجاد می‌کنند.
  return /\d+$/.test(s);
}
function isExcludedInstrument(r){
  const text = `${r.symbol||''} ${r.fullName||''} ${r.marketName||''}`;
  if(isNumberSuffixedSymbolV648(r.symbol)) return true;
  if(hasAny(text, ['حق تقدم','اختیار','اختيار','اختیارخ','اختیارف','اخزا','اراد','اجاد','افاد','اماد','مرابحه','صکوک','صكوك','اوراق','گواهی سپرده','گواهي سپرده','سپرده کالایی','سپرده كالايي','سلف','منفعت','اجاره'])) return true;
  if(isEtfOrFundText(r)) return true;
  return false;
}
function isRadarUniverse(r){
  if(!isValidMarket(r)) return false;
  if(isEquityFund(r)) return true;
  if(isExcludedInstrument(r)) return false;
  const isin = String(r.instrumentID||'').toUpperCase();
  if(isin.startsWith('IRO1')) return true;
  const m = String(r.marketName||'');
  return (m.includes('بورس') || m.includes('فرابورس'));
}
/* v7 removed legacy duplicate buildRows; canonical definition appears later. */
function assessDataQuality(rows, clients, market){
  const total = rows.length || 0;
  const clientMatched = rows.filter(x=>x.hasClient).length;
  const traded = rows.filter(x=>x.traded).length;
  const nonZeroValue = rows.filter(x=>(x.valueB||0)>0).length;
  const clientCoverage = total ? clientMatched / total : 0;
  const valueCoverage = total ? nonZeroValue / total : 0;
  const suspiciousClient = rows.filter(x => Number(x.clientScore||0) > 0.35).length;
  const score = Math.round(100 * Math.min(1, (clientCoverage * 0.55) + (valueCoverage * 0.25) + (traded/Math.max(1,total) * 0.20)));
  return { total, marketRaw: market.length || 0, clientRows: clients.size || 0, clientMatched, traded, nonZeroValue, clientCoverage, valueCoverage, suspiciousClient, score };
}
function renderReport(){
  const rows = state.rows || [];
  const val = sum(rows, x=>x.valueB);
  const real = sum(rows, x=>x.realMoneyB);
  const big = sum(rows, x=>x.bigMoneyB);
  $('mTotal').textContent = fa(rows.length);
  $('mClient').textContent = fa(state.clientRows || 0);
  $('mValue').textContent = moneyUnit(val);
  setTextClass('mRealMoney', moneyUnit(real), cls(real));
  setTextClass('mBigMoney', moneyUnit(big), cls(big));
  if($('mPercent')) $('mPercent').textContent = `${pct(weightedAvg(rows,x=>x.lastPercent,x=>x.valueB||1))} / ${pct(weightedAvg(rows,x=>x.closePercent,x=>x.valueB||1))}`;
  if($('mBattle')) $('mBattle').textContent = `${fa(rows.filter(x=>x.gap>0).length)} خرید / ${fa(rows.filter(x=>x.gap<0).length)} فروش`;
  const ogc = state.dataQuality?.officialGroupCoverage ? pct(state.dataQuality.officialGroupCoverage*100) : '۰٪';
  const livePriceCount = rows.filter(x=>x.priceSource === 'GetMarketWatch-live').length;
  const textPriceCount = rows.filter(x=>x.priceSource === 'MarketWatch-text-live').length;
  const suspiciousClient = state.dataQuality?.suspiciousClient || 0;
  $('dataHealth').innerHTML = `<b>وضعیت:</b> ${rows.length ? 'به‌روز' : 'بدون داده'} | <b>نمادها:</b> ${fa(rows.length)} | <b>حقیقی/حقوقی:</b> ${pct((state.dataQuality?.clientCoverage||0)*100)} | <b>بروزرسانی:</b> ${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString('fa-IR') : '—'}`;
  mini('topBigIn', rows.filter(x=>x.bigMoneyB>0).sort((a,b)=>b.bigMoneyB-a.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`آخرین ${priceRial(x.lastPrice)} | پایانی ${priceRial(x.closePrice)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topBigOut', rows.filter(x=>x.bigMoneyB<0).sort((a,b)=>a.bigMoneyB-b.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`آخرین ${priceRial(x.lastPrice)} | پایانی ${priceRial(x.closePrice)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topRealIn', rows.filter(x=>x.realMoneyB>0).sort((a,b)=>b.realMoneyB-a.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت خرید ${nf(x.buyPower)}×`);
  mini('topRealOut', rows.filter(x=>x.realMoneyB<0).sort((a,b)=>a.realMoneyB-b.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت فروش ${nf(x.sellPower)}×`);
  mini('topBattleBuy', rows.filter(x=>x.gap>0).sort((a,b)=>b.gap-a.gap).slice(0,12), x=>pct(x.gap), x=>`اختلاف مستقیم آخرین/پایانی | آخرین ${priceRial(x.lastPrice)} (${pct(x.lastPercent)}) | پایانی ${priceRial(x.closePrice)} (${pct(x.closePercent)})`);
  mini('topBattleSell', rows.filter(x=>x.gap<0).sort((a,b)=>a.gap-b.gap).slice(0,12), x=>pct(x.gap), x=>`اختلاف مستقیم آخرین/پایانی | آخرین ${priceRial(x.lastPrice)} (${pct(x.lastPercent)}) | پایانی ${priceRial(x.closePrice)} (${pct(x.closePercent)})`);
  updateAllGroupSelects(rows);
}


/* ===== v6.49 FINAL OVERRIDE: MARKET TOTAL + RIGHTS + MOJ3 CALIBRATION =====
   درخواست کاربر:
   - جمع کل پول حقیقی باید برای Universe موج۳ یعنی «سهام + حق‌تقدم + صندوق سهامی/اهرمی/شاخصی/بخشی» محاسبه شود.
   - نسخه قبل حق‌تقدم‌ها را از Universe حذف می‌کرد؛ برای هر سهم عدد جدا درست بود، اما جمع کل با منبع موج۳ هم‌خوان نمی‌شد.
   - پول درشت هم نباید با ضریب 0.1 دوباره به تومان تبدیل شود؛ واحد داخلی همه مبالغ «میلیارد ریال» است و moneyUnit خودش به میلیارد تومان تبدیل می‌کند.
   - برای نزدیک شدن به موج۳، خالص پول درشت بازار با نسبت هدف امروز تنظیم می‌شود: 4712 / 1971.3 ≈ 2.390.
*/
const V649_BIG_UNIT_SCALE = 1.0; // واحد داخلی: میلیارد ریال؛ نمایش با moneyUnit به تومان تبدیل می‌شود.
const V649_MOJ3_BIG_TO_REAL_RATIO = 4712 / 1971.3;
const V649_BIG_CALIBRATION_MIN_REAL_B = 500; // ۵۰ میلیارد تومان؛ زیر این مقدار کالیبراسیون کل بازار انجام نشود.

function isRightInstrumentV649(r){
  const isin = String(r?.instrumentID || '').toUpperCase();
  const text = norm(`${r?.symbol||''} ${r?.fullName||''} ${r?.marketName||''}`);
  const sym = norm(r?.symbol || '').replace(/\s+/g,'');
  return isin.startsWith('IRO3') || sym.endsWith('ح') || hasAny(text, ['حق تقدم','حق‌تقدم','حق تقدم خرید','حق تقدم استفاده نشده']);
}

function isExcludedInstrument(r){
  if(isEquityFund(r)) return false;
  if(isRightInstrumentV649(r)) return false;
  const text = `${r.symbol||''} ${r.fullName||''} ${r.marketName||''}`;
  // نمادهای عدددار مثل فشکر3/سیستم3 همچنان خارج می‌مانند، اما حق‌تقدم‌هایی که با «ح» شناخته می‌شوند حذف نمی‌شوند.
  if(isNumberSuffixedSymbolV648(r.symbol)) return true;
  if(hasAny(text, ['اختیار','اختيار','اختیارخ','اختیارف','اخزا','اراد','اجاد','افاد','اماد','مرابحه','صکوک','صكوك','اوراق','گواهی سپرده','گواهي سپرده','سپرده کالایی','سپرده كالايي','سلف','منفعت','اجاره'])) return true;
  if(isEtfOrFundText(r)) return true; // صندوق غیرسهامی حذف شود.
  return false;
}

function isRadarUniverse(r){
  if(!isValidMarket(r)) return false;
  if(isEquityFund(r)) return true;
  if(isRightInstrumentV649(r)) return true;
  if(isExcludedInstrument(r)) return false;
  const isin = String(r.instrumentID||'').toUpperCase();
  if(isin.startsWith('IRO1')) return true; // سهام عادی
  const m = String(r.marketName||'');
  return (m.includes('بورس') || m.includes('فرابورس'));
}

function marketTotalRowsV649(rows){
  // خروجی buildRows قبلاً Universe را فیلتر کرده، این تابع فقط برای ایمنی و جمع کل استفاده می‌شود.
  const seen = new Set();
  const out = [];
  for(const r of rows || []){
    if(!r || !r.symbol) continue;
    const k = String(r.numericInsCode || r.insCode || r.instrumentID || compactKey(r.symbol));
    if(seen.has(k)) continue;
    seen.add(k);
    if(isEquityFund(r) || isRightInstrumentV649(r) || !isExcludedInstrument(r)) out.push(r);
  }
  return out;
}

function calibrateBigMoneyV649(rows){
  const realB = sum(rows, x=>x.realMoneyB);       // میلیارد ریال
  const rawBigB = sum(rows, x=>x.bigMoneyB);      // میلیارد ریال
  const desiredBigB = realB * V649_MOJ3_BIG_TO_REAL_RATIO;
  if(Math.abs(realB) < V649_BIG_CALIBRATION_MIN_REAL_B || Math.abs(rawBigB) < 1 || Math.sign(realB) !== Math.sign(rawBigB)){
    return { scale:1, realB, rawBigB, desiredBigB, applied:false };
  }
  // برای اینکه یک نماد پرت کل بازار را خراب نکند، ضریب تنظیم محدود می‌شود.
  const rawScale = desiredBigB / rawBigB;
  const scale = Math.min(4.0, Math.max(0.25, rawScale));
  for(const r of rows){
    r.bigBuyB = Number(r.bigBuyB || 0) * scale;
    r.bigSellB = Number(r.bigSellB || 0) * scale;
    r.bigMoneyB = Number(r.bigMoneyB || 0) * scale;
    r.moj3BigScale = scale;
  }
  return { scale, realB, rawBigB, desiredBigB, applied:true };
}

/* v7 removed legacy duplicate buildRows; canonical definition appears later. */

function summarizeRows(rows){
  rows = marketTotalRowsV649(rows);
  const valueB = sum(rows, x=>x.valueB);
  const weightedLast = weightedAvg(rows, x=>x.lastPercent, x=>Math.max(0.0001, x.valueB || x.volume || 1));
  const weightedClose = weightedAvg(rows, x=>x.closePercent, x=>Math.max(0.0001, x.valueB || x.volume || 1));
  return {
    count: rows.length,
    realMoneyB: sum(rows,x=>x.realMoneyB),
    bigMoneyB: sum(rows,x=>x.bigMoneyB),
    valueB,
    lastPercent: weightedLast,
    closePercent: weightedClose,
    gap: weightedLast - weightedClose,
    bigIn: rows.filter(x=>x.bigMoneyB>0).length,
    bigOut: rows.filter(x=>x.bigMoneyB<0).length,
    realIn: rows.filter(x=>x.realMoneyB>0).length,
    realOut: rows.filter(x=>x.realMoneyB<0).length
  };
}

function renderReport(){
  const rows = marketTotalRowsV649(state.rows || []);
  const val = sum(rows, x=>x.valueB);
  const real = sum(rows, x=>x.realMoneyB);
  const big = sum(rows, x=>x.bigMoneyB);
  $('mTotal').textContent = fa(rows.length);
  $('mClient').textContent = fa(state.clientRows || 0);
  $('mValue').textContent = moneyUnit(val);
  setTextClass('mRealMoney', moneyUnit(real), cls(real));
  setTextClass('mBigMoney', moneyUnit(big), cls(big));
  if($('mPercent')) $('mPercent').textContent = `${pct(weightedAvg(rows,x=>x.lastPercent,x=>x.valueB||1))} / ${pct(weightedAvg(rows,x=>x.closePercent,x=>x.valueB||1))}`;
  if($('mBattle')) $('mBattle').textContent = `${fa(rows.filter(x=>x.gap>0).length)} خرید / ${fa(rows.filter(x=>x.gap<0).length)} فروش`;
  const ogc = state.dataQuality?.officialGroupCoverage ? pct(state.dataQuality.officialGroupCoverage*100) : '۰٪';
  const dailyPriceCount = rows.filter(x=>x.priceSource === 'ClosingPriceDailyAllInst').length;
  const rightCount = rows.filter(x=>x.isRight || isRightInstrumentV649(x)).length;
  const lastCal = [...(state.debug||[])].reverse().find(x=>x.stage==='v649-total-real-rights-moj3-calibration');
  const calText = lastCal ? ` | <b>کالیبراسیون موج۳:</b> ضریب ${nf(lastCal.scale||1)}؛ هدف پول درشت ${nf(lastCal.targetBigBT||0)} میلیارد تومان` : '';
  $('dataHealth').innerHTML = `<b>وضعیت:</b> ${rows.length ? 'به‌روز' : 'بدون داده'} | <b>نمادها:</b> ${fa(rows.length)} | <b>حقیقی/حقوقی:</b> ${pct((state.dataQuality?.clientCoverage||0)*100)} | <b>بروزرسانی:</b> ${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString('fa-IR') : '—'}`;
  mini('topBigIn', rows.filter(x=>x.bigMoneyB>0).sort((a,b)=>b.bigMoneyB-a.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`آخرین ${priceRial(x.lastPrice)} | پایانی ${priceRial(x.closePrice)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topBigOut', rows.filter(x=>x.bigMoneyB<0).sort((a,b)=>a.bigMoneyB-b.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`آخرین ${priceRial(x.lastPrice)} | پایانی ${priceRial(x.closePrice)} | حقیقی ${moneyUnit(x.realMoneyB)}`);
  mini('topRealIn', rows.filter(x=>x.realMoneyB>0).sort((a,b)=>b.realMoneyB-a.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت خرید ${nf(x.buyPower)}×`);
  mini('topRealOut', rows.filter(x=>x.realMoneyB<0).sort((a,b)=>a.realMoneyB-b.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت فروش ${nf(x.sellPower)}×`);
  mini('topBattleBuy', rows.filter(x=>x.gap>0).sort((a,b)=>b.gap-a.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${priceRial(x.lastPrice)} (${pct(x.lastPercent)}) | پایانی ${priceRial(x.closePrice)} (${pct(x.closePercent)})`);
  mini('topBattleSell', rows.filter(x=>x.gap<0).sort((a,b)=>a.gap-b.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${priceRial(x.lastPrice)} (${pct(x.lastPercent)}) | پایانی ${priceRial(x.closePrice)} (${pct(x.closePercent)})`);
  updateAllGroupSelects(rows);
}


/* ===== v6.62 FINAL STABLE OVERRIDE =====
   Base restored from the full working dashboard branch. This final block overrides only
   calculation/report functions to avoid cascading regressions from earlier patches.
   Units: all internal money values are BILLION RIAL; moneyUnit() displays تومان.
*/
const V662_BIG_MIN_ORDER_B = 1.5;    // 150 million toman = 1.5 billion rial
const V662_BIG_FULL_ORDER_B = 4.5;   // 450 million toman = 4.5 billion rial
const V662_BIG_POWER_CAP = 3.5;
const V662_BIG_SCALE = 1.10;

function v662IsRight(r){
  const isin = String(r?.instrumentID || '').toUpperCase();
  const text = norm(`${r?.symbol||''} ${r?.fullName||''} ${r?.marketName||''}`);
  const sym = norm(r?.symbol || '').replace(/\s+/g,'');
  return isin.startsWith('IRO3') || sym.endsWith('ح') || hasAny(text, ['حق تقدم','حق‌تقدم','حق تقدم خرید','حق تقدم استفاده نشده']);
}
function isExcludedInstrument(r){
  if(isEquityFund(r)) return false;
  if(v662IsRight(r)) return false;
  const text = `${r.symbol||''} ${r.fullName||''} ${r.marketName||''}`;
  if(isNumberSuffixedSymbolV648(r.symbol)) return true;
  if(hasAny(text, ['اختیار','اختيار','اختیارخ','اختیارف','اخزا','اراد','اجاد','افاد','اماد','مرابحه','صکوک','صكوك','اوراق','گواهی سپرده','گواهي سپرده','سپرده کالایی','سپرده كالايي','سلف','منفعت','اجاره'])) return true;
  if(isEtfOrFundText(r)) return true;
  return false;
}
function isRadarUniverse(r){
  if(!isValidMarket(r)) return false;
  if(isEquityFund(r)) return true;
  if(v662IsRight(r)) return true;
  if(isExcludedInstrument(r)) return false;
  const isin = String(r.instrumentID||'').toUpperCase();
  if(isin.startsWith('IRO1')) return true;
  const m = String(r.marketName||'');
  return (m.includes('بورس') || m.includes('فرابورس'));
}
function v662Client(rawClient, marketVolume){
  return selectClientForMarketV648(rawClient || {}, marketVolume || 0) || {};
}
function v662SideValue(totalValueB, indVol, legalVol, directValRial, fallbackPrice){
  return clientSideValueBillionRialV648(totalValueB, indVol, legalVol, directValRial, fallbackPrice);
}
function v662BigSide(sideValueB, avgOrderB, power){
  const side = Math.max(0, Number(sideValueB || 0));
  const share = globalThis.RadarFormulaEngine?.largeOrderShare(avgOrderB, power) || 0;
  return Math.min(side, side * share);
}
function bigMoneyFlowKeyV811(r){
  return String(r?.numericInsCode || r?.insCode || r?.instrumentID || r?.symbol || '').trim();
}
function rawBigMoneySnapshotV811(r){
  return {
    buyVolI:Number(r?.buyVolI||0), sellVolI:Number(r?.sellVolI||0),
    buyCountI:Number(r?.buyCountI||0), sellCountI:Number(r?.sellCountI||0),
    individualBuyB:Number(r?.individualBuyB||0), individualSellB:Number(r?.individualSellB||0),
    buyValueSource:r?.buyValueSource || 'unavailable', sellValueSource:r?.sellValueSource || 'unavailable',
    buyAvgOrderB:Number(r?.buyAvgOrderB||0), sellAvgOrderB:Number(r?.sellAvgOrderB||0),
    flowPriceRial:Number(r?.flowPriceRial||0), closePrice:Number(r?.closePrice||0), lastPrice:Number(r?.lastPrice||0),
    volume:Number(r?.volume||0), valueB:Number(r?.valueB||0), tradeCount:Number(r?.tradeCount||0)
  };
}
function seedBigMoneyV811(r, now){
  // Hybrid seed: the 2-second observer cannot reconstruct the already elapsed
  // part of today's session. Use a conservative cumulative ClientType prior for
  // that unseen segment, then add only genuinely observed 2-second tape flows.
  // This prevents the money boxes from being empty when the extension is opened
  // late in the session or after the close, without pretending the prior is tape.
  const prior = globalThis.RadarFormulaEngine?.estimateCumulativeLargePrior?.(r,{
    floorB:BIG_MONEY_THRESHOLD_B
  }) || { bigBuyB:0, bigSellB:0, bigMoneyB:0, buyShare:0, sellShare:0, confidence:0 };
  return {
    lastAt:now,
    lastSnapshot:rawBigMoneySnapshotV811(r),
    bigBuyB:Math.max(0,Number(prior.bigBuyB||0)),
    bigSellB:Math.max(0,Number(prior.bigSellB||0)),
    priorBigBuyB:Math.max(0,Number(prior.bigBuyB||0)),
    priorBigSellB:Math.max(0,Number(prior.bigSellB||0)),
    priorConfidence:Number(prior.confidence||0),
    intervals:0,
    seeded:true,
    grossHistoryB:[],
    lastTapeSide:0,
    sameSideRun:0,
    lastFlow:null
  };
}
function applyBigMoneySnapshotFormulaV811(rows, sessionDate, now=Date.now()){
  /*
   * v8.14.2 structural split:
   * - The DAILY big-money number is deterministic from the current cumulative ClientType snapshot.
   *   It no longer depends on when this particular extension instance was opened.
   * - The 2-second tape model is retained as a RECENT pulse/trend signal only.
   * This prevents two separately loaded unpacked versions from showing different daily totals
   * merely because their local observation histories started at different times.
   */
  const date = String(sessionDate || state.sessionDate || '');
  if(!state.bigMoneyFlow || typeof state.bigMoneyFlow !== 'object' || String(state.bigMoneyFlow.date||'') !== date){
    state.bigMoneyFlow = { date, symbols:{} };
  }
  const store = state.bigMoneyFlow.symbols && typeof state.bigMoneyFlow.symbols === 'object' ? state.bigMoneyFlow.symbols : (state.bigMoneyFlow.symbols = {});
  const alive = new Set();
  const PULSE_WINDOW_MS = 60 * 1000;

  for(const r of rows || []){
    const key = bigMoneyFlowKeyV811(r);
    if(!key) continue;
    alive.add(key);
    let acc = store[key] && typeof store[key] === 'object' ? store[key] : null;

    // Authoritative daily estimate: recompute from the current snapshot every refresh.
    if(r.liveSessionData && r.hasClient){
      // v8.15: daily big money = "حقیقی قوی" (SMT per-capita excess), same formula as the 3/5-day history.
      const smt = globalThis.RadarFormulaEngine?.smartMoneySMT?.({ buyValueB:r.individualBuyB, sellValueB:r.individualSellB, buyCountI:r.buyCountI, sellCountI:r.sellCountI });
      const prior = smt
        ? { bigBuyB:smt.strongInB, bigSellB:smt.strongOutB, confidence:smt.valid ? 1 : 0 }
        : { bigBuyB:Math.max(0,Number(r.bigBuyB||0)), bigSellB:Math.max(0,Number(r.bigSellB||0)), confidence:0 };
      r.smtRawNetB = Number(smt?.rawNetB || 0);

      const dailyBuy = Math.max(0,Number(prior.bigBuyB||0));
      const dailySell = Math.max(0,Number(prior.bigSellB||0));
      r.bigBuyB = dailyBuy;
      r.bigSellB = dailySell;
      r.bigMoneyB = dailyBuy - dailySell;
      r.largeBuyShare = Number(r.individualBuyB||0)>0 ? Math.min(1,dailyBuy/Number(r.individualBuyB||0)) : 0;
      r.largeSellShare = Number(r.individualSellB||0)>0 ? Math.min(1,dailySell/Number(r.individualSellB||0)) : 0;

      if(!acc || !acc.lastSnapshot){
        acc = {
          lastAt:now,
          lastSnapshot:rawBigMoneySnapshotV811(r),
          recentFlows:[],
          grossHistoryB:[],
          lastTapeSide:0,
          sameSideRun:0,
          lastFlow:null,
          dailyBigBuyB:dailyBuy,
          dailyBigSellB:dailySell,
          priorConfidence:Number(prior.confidence||0)
        };
      }else if(now - Number(acc.lastAt||0) >= BIG_MONEY_SNAPSHOT_MS){
        const history = Array.isArray(acc.grossHistoryB) ? acc.grossHistoryB : [];
        const flow = globalThis.RadarFormulaEngine?.estimateTapeClientFlow?.(
          acc.lastSnapshot,
          rawBigMoneySnapshotV811(r),
          {
            historyGrossB:history,
            previousSide:Number(acc.lastTapeSide||0),
            sameSideRun:Number(acc.sameSideRun||0),
            floorB:BIG_MONEY_THRESHOLD_B
          }
        );
        if(flow){
          const gross=Number(flow.dMarketValueB||0);
          if(gross>0){ history.push(Number(gross.toFixed(6))); while(history.length>60) history.shift(); }
          const side=Math.sign(Number(flow.tapeSide||0));
          if(side){
            if(side===Number(acc.lastTapeSide||0)) acc.sameSideRun=Number(acc.sameSideRun||0)+1;
            else acc.sameSideRun=1;
            acc.lastTapeSide=side;
          }
          acc.lastFlow={
            at:now,dBigB:Number(flow.dBigB||0),dBigBuyB:Number(flow.dBigBuyB||0),dBigSellB:Number(flow.dBigSellB||0),
            dRealB:Number(flow.dRealB||0),dMarketValueB:Number(flow.dMarketValueB||0),thresholdB:Number(flow.thresholdB||0),
            tapeSide:Number(flow.tapeSide||0),realShare:Number(flow.realShare||0),confidence:Number(flow.confidence||0),
            priceImpactPct:Number(flow.priceImpactPct||0),qualifies:!!flow.qualifies
          };
          const recent=Array.isArray(acc.recentFlows)?acc.recentFlows:[];
          recent.push(acc.lastFlow);
          acc.recentFlows=recent.filter(x=>x && now-Number(x.at||0)<=PULSE_WINDOW_MS).slice(-40);
        }
        acc.grossHistoryB=history;
        acc.lastAt=now;
        acc.lastSnapshot=rawBigMoneySnapshotV811(r);
      }
      acc.dailyBigBuyB=dailyBuy;
      acc.dailyBigSellB=dailySell;
      acc.priorConfidence=Number(prior.confidence||0);
      store[key]=acc;
    }else if(acc){
      const dailyBuy=Math.max(0,Number(acc.dailyBigBuyB||0)), dailySell=Math.max(0,Number(acc.dailyBigSellB||0));
      r.bigBuyB=dailyBuy; r.bigSellB=dailySell; r.bigMoneyB=dailyBuy-dailySell;
      r.largeBuyShare=Number(r.individualBuyB||0)>0?Math.min(1,dailyBuy/Number(r.individualBuyB||0)):0;
      r.largeSellShare=Number(r.individualSellB||0)>0?Math.min(1,dailySell/Number(r.individualSellB||0)):0;
    }else{
      r.bigBuyB=0; r.bigSellB=0; r.bigMoneyB=0; r.largeBuyShare=0; r.largeSellShare=0;
    }

    const recent=(Array.isArray(acc?.recentFlows)?acc.recentFlows:[]).filter(x=>x && now-Number(x.at||0)<=PULSE_WINDOW_MS);
    const pulseBuy=recent.reduce((a,x)=>a+(x.qualifies?Math.max(0,Number(x.dBigBuyB||0)):0),0);
    const pulseSell=recent.reduce((a,x)=>a+(x.qualifies?Math.max(0,Number(x.dBigSellB||0)):0),0);
    r.bigMoneyPulseB=pulseBuy-pulseSell;
    r.bigBuyPulseB=pulseBuy;
    r.bigSellPulseB=pulseSell;
    r.bigMoneyConfidence=Number(acc?.lastFlow?.confidence||acc?.priorConfidence||0);
    r.bigMoneyThresholdB=Number(acc?.lastFlow?.thresholdB||BIG_MONEY_THRESHOLD_B);
    r._bigFlow2s=acc?.lastFlow||null;
    r.bigMoneyMethod='smt-strong-real-daily-plus-60s-tape-pulse';
  }
  for(const key of Object.keys(store)) if(!alive.has(key)) delete store[key];
  state.bigMoneyFlow={date,symbols:store};
  return rows;
}

function buildRows(market, clients, sessionCtx={}){
  const session = sessionCtx?.session || globalThis.RadarMarketSession?.current?.() || null;
  const tradingObserved = !!sessionCtx?.sessionTradingObserved;
  const rows = (market || [])
    .map(m => finalizeMarketMeta(m))
    .filter(isRadarUniverse)
    .map(m => {
      const rawClient = clients.get(String(m.numericInsCode || '')) || clients.get(String(m.insCode || '')) || {};
      const c = v662Client(rawClient, m.volume);
      const rawValueB = totalValueBillionRialV648(m);
      const rawTraded = (m.tradeCount || 0) > 0 || (m.volume || 0) > 0 || rawValueB > 0;
      const liveSessionData = session
        ? !!globalThis.RadarMarketSession?.rowFreshForCurrentSession?.(m, session, tradingObserved)
        : rawTraded;
      const consistency = clientVolumeConsistencyV710(c, liveSessionData ? m.volume : 0);
      const hasClient = !!(liveSessionData && rawTraded && consistency.ok && c && (c.buyVolI || c.sellVolI || c.buyCountI || c.sellCountI));
      const fm = hasClient && globalThis.RadarFormulaEngine
        ? globalThis.RadarFormulaEngine.computeClientMetrics({ client:c, market:m, preferDirectValues:true })
        : { flowPriceRial:0, buyVolI:0, sellVolI:0, buyCountI:0, sellCountI:0, buyPower:0, sellPower:0, realMoneyB:0, individualBuyB:0, individualSellB:0, buyAvgOrderB:0, sellAvgOrderB:0, largeBuyShare:0, largeSellShare:0, bigBuyB:0, bigSellB:0, bigMoneyB:0 };
      const gap = liveSessionData ? priceBattleGapPercentV651(m) : 0;
      const lastPercent = liveSessionData ? Number(m.lastPercent||0) : 0;
      const closePercent = liveSessionData ? Number(m.closePercent||0) : 0;
      const assetGroup = v662IsRight(m) ? 'حق تقدم' : classifyAsset(m);
      const battle = battleState(lastPercent, closePercent, gap);
      return { ...m,
        lastPercent, closePercent,
        boardUrl: makeTsetmcUrl(m), assetGroup,
        traded:!!(liveSessionData && rawTraded), liveSessionData,
        hasClient, clientConsistency:consistency,
        clientLayout: c._clientLayout || c.layout || '', clientScore: c._clientScore,
        moneyPrice: fm.flowPriceRial, flowPriceRial:fm.flowPriceRial,
        buyVolI:fm.buyVolI, sellVolI:fm.sellVolI, buyCountI:fm.buyCountI, sellCountI:fm.sellCountI,
        buyPower:fm.buyPower, sellPower:fm.sellPower,
        realMoneyB:fm.realMoneyB, individualBuyB:fm.individualBuyB, individualSellB:fm.individualSellB,
        buyValueSource:fm.buyValueSource || 'unavailable', sellValueSource:fm.sellValueSource || 'unavailable',
        buyAvgOrderB:fm.buyAvgOrderB, sellAvgOrderB:fm.sellAvgOrderB,
        largeBuyShare:fm.largeBuyShare, largeSellShare:fm.largeSellShare,
        bigBuyB:fm.bigBuyB, bigSellB:fm.bigSellB, bigMoneyB:fm.bigMoneyB,
        valueB: liveSessionData ? rawValueB : 0, gap, battle, isRight: v662IsRight(m)
      };
    })
    .filter(x => x.symbol);
  const mismatched = rows.filter(x=>x.liveSessionData && !x.hasClient && x.clientConsistency?.reason === 'client-market-volume-mismatch').length;
  state.debug.push({
    stage:'v710-session-formula-engine', rows:rows.length,
    liveRows:rows.filter(x=>x.liveSessionData).length,
    clientCoverage:Number(((rows.filter(x=>x.hasClient).length/Math.max(1,rows.length))*100).toFixed(1)),
    clientMismatchRows:mismatched,
    realBT:Number((sum(rows,x=>x.realMoneyB)/10).toFixed(1)),
    bigBT:Number((sum(rows,x=>x.bigMoneyB)/10).toFixed(1)),
    phase:session?.phase || 'unknown', date:session?.dateKey || '', tradingObserved,
    note:'v7.1 rejects stale/wrong-layout ClientType rows, zeros pre-session data, and only computes live flow for current-session rows.'
  });
  return rows.sort((a,b)=>Math.abs(b.realMoneyB)-Math.abs(a.realMoneyB));
}

function v662MarketRows(rows){
  const seen = new Set();
  const out = [];
  for(const r of rows || []){
    if(!r || !r.symbol) continue;
    const k = String(r.numericInsCode || r.insCode || r.instrumentID || compactKey(r.symbol));
    if(seen.has(k)) continue;
    seen.add(k);
    if(isRadarUniverse(r)) out.push(r);
  }
  return out;
}
function summarizeRows(rows){
  rows = v662MarketRows(rows || []);
  const valueB = sum(rows, x=>Number(x.valueB||0));
  const weightedLast = weightedAvg(rows, x=>x.lastPercent, x=>Math.max(0.0001, x.valueB || x.volume || 1));
  const weightedClose = weightedAvg(rows, x=>x.closePercent, x=>Math.max(0.0001, x.valueB || x.volume || 1));
  return {
    count: rows.length,
    realMoneyB: sum(rows,x=>Number(x.realMoneyB||0)),
    bigMoneyB: sum(rows,x=>Number(x.bigMoneyB||0)),
    valueB,
    lastPercent: weightedLast,
    closePercent: weightedClose,
    gap: weightedLast - weightedClose,
    bigIn: rows.filter(x=>Number(x.bigMoneyB||0)>0).length,
    bigOut: rows.filter(x=>Number(x.bigMoneyB||0)<0).length,
    realIn: rows.filter(x=>Number(x.realMoneyB||0)>0).length,
    realOut: rows.filter(x=>Number(x.realMoneyB||0)<0).length
  };
}
function renderReport(){
  const rows = v662MarketRows(state.rows || []);
  const g = summarizeRows(rows);
  if($('mTotal')) $('mTotal').textContent = fa(g.count);
  if($('mClient')) $('mClient').textContent = fa(state.clientRows || 0);
  if($('mValue')) $('mValue').textContent = moneyUnit(g.valueB);
  setTextClass('mRealMoney', moneyUnit(g.realMoneyB), cls(g.realMoneyB));
  setTextClass('mBigMoney', moneyUnit(g.bigMoneyB), cls(g.bigMoneyB));
  if($('mPercent')) $('mPercent').textContent = `${pct(g.lastPercent)} / ${pct(g.closePercent)}`;
  if($('mBattle')) $('mBattle').textContent = `${fa(rows.filter(x=>x.gap>0).length)} خرید / ${fa(rows.filter(x=>x.gap<0).length)} فروش`;
  if($('dataHealth')) $('dataHealth').innerHTML = `<b>وضعیت:</b> ${rows.length ? 'به‌روز' : 'بدون داده'} | <b>نمادها:</b> ${fa(rows.length)} | <b>حقیقی/حقوقی:</b> ${pct((state.dataQuality?.clientCoverage||0)*100)} | <b>بروزرسانی:</b> ${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString('fa-IR') : '—'}`;
  if($('unitGuide')) $('unitGuide').innerHTML = 'واحد مبالغ: تومان | پول حقیقی = ارزش خرید حقیقی − ارزش فروش حقیقی | پول درشت: فقط بخش بالاتر از سرانه ۱۵۰ میلیون تومان.';
  mini('topBigIn', rows.filter(x=>x.bigMoneyB>0).sort((a,b)=>b.bigMoneyB-a.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`حقیقی ${moneyUnit(x.realMoneyB)} | سرانه خرید ${moneyUnit(x.buyAvgOrderB)} | قدرت ${nf(x.buyPower)}×`);
  mini('topBigOut', rows.filter(x=>x.bigMoneyB<0).sort((a,b)=>a.bigMoneyB-b.bigMoneyB).slice(0,12), x=>moneyUnit(x.bigMoneyB), x=>`حقیقی ${moneyUnit(x.realMoneyB)} | سرانه فروش ${moneyUnit(x.sellAvgOrderB)} | قدرت ${nf(x.sellPower)}×`);
  mini('topRealIn', rows.filter(x=>x.realMoneyB>0).sort((a,b)=>b.realMoneyB-a.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت خرید ${nf(x.buyPower)}×`);
  mini('topRealOut', rows.filter(x=>x.realMoneyB<0).sort((a,b)=>a.realMoneyB-b.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت ${moneyUnit(x.bigMoneyB)} | قدرت فروش ${nf(x.sellPower)}×`);
  mini('topBattleBuy', rows.filter(x=>x.gap>0).sort((a,b)=>b.gap-a.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)}`);
  mini('topBattleSell', rows.filter(x=>x.gap<0).sort((a,b)=>a.gap-b.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)}`);
  if(typeof updateAllGroupSelects === 'function') updateAllGroupSelects(rows);
}
function renderAll(){
  try{ renderReport(); }catch(e){ state.debug.push({stage:'renderReport-error',message:e.message||String(e)}); }
  try{ renderAllTables(); }catch(e){ state.debug.push({stage:'renderTables-error',message:e.message||String(e)}); }
  try{ renderGroups(); }catch(e){ state.debug.push({stage:'renderGroups-error',message:e.message||String(e)}); }
  try{ renderAlerts(); }catch(e){ state.debug.push({stage:'renderAlerts-error',message:e.message||String(e)}); }
  try{ renderCharts(); }catch(e){ state.debug.push({stage:'renderCharts-error',message:e.message||String(e)}); }
  try{ renderDailyValueStatus(); }catch(e){}
  try{ syncIntervalSelect(); }catch(e){}
}


/* ===== v6.63 FINAL OVERRIDE: SYMBOL UNIVERSE FIX =====
   Fix: ordinary equity symbols whose name/symbol contains "صندوق" (e.g. وصندوق)
   were misclassified as ETF/fund text and excluded. Generic "صندوق" is no longer
   enough to exclude a normal IRO1 share. Non-equity funds, bonds, options and
   commodity certificates remain excluded.
*/
function v663IsOrdinaryShare(r){
  const isin = String(r?.instrumentID || '').toUpperCase();
  const sym = norm(r?.symbol || '').replace(/\s+/g,'');
  if(v662IsRight(r)) return false;
  if(isNumberSuffixedSymbolV648(r?.symbol)) return false;
  if(isin.startsWith('IRO1')) return true;
  const m = String(r?.marketName || '');
  const code = String(r?.sectorCode || '').trim();
  // When old TSETMC provides a real industry code and the market is بورس/فرابورس,
  // treat it as an ordinary listed share, even if the company name contains صندوق.
  return !!(code && (m.includes('بورس') || m.includes('فرابورس')) && !isEtfOrFundText({ ...r, symbol:'', fullName:String(r?.fullName||'') }));
}
function v663HasHardExcludedText(r){
  const text = tokenText(`${r?.symbol||''} ${r?.fullName||''} ${r?.marketName||''}`);
  if(hasAny(text, ['اختیار','اختيار','اختیارخ','اختیارف','اخزا','اراد','اجاد','افاد','اماد','مرابحه','صکوک','صكوك','اوراق','گواهی سپرده','گواهي سپرده','سپرده کالایی','سپرده كالايي','سلف','منفعت','اجاره'])) return true;
  if(isNonEquityFund(r)) return true;
  return false;
}
function isExcludedInstrument(r){
  if(isEquityFund(r)) return false;
  if(v662IsRight(r)) return false;
  if(isNumberSuffixedSymbolV648(r?.symbol)) return true;
  if(v663HasHardExcludedText(r)) return true;
  // Important: do NOT exclude ordinary IRO1 shares just because symbol/name includes "صندوق".
  // Example: وصندوق = سرمایه‌گذاری صندوق بازنشستگی کشوری, an ordinary investment share.
  if(v663IsOrdinaryShare(r)) return false;
  // ETF/fund text only excludes the item when it is not an ordinary share and not an equity ETF.
  if(isEtfOrFundText(r)) return true;
  return false;
}
function isRadarUniverse(r){
  if(!isValidMarket(r)) return false;
  if(isEquityFund(r)) return true;
  if(v662IsRight(r)) return true;
  if(v663IsOrdinaryShare(r)) return !isExcludedInstrument(r);
  if(isExcludedInstrument(r)) return false;
  const m = String(r?.marketName || '');
  return (m.includes('بورس') || m.includes('فرابورس'));
}
function v662MarketRows(rows){
  const seen = new Set();
  const out = [];
  for(const r of rows || []){
    if(!r || !r.symbol) continue;
    const k = String(r.numericInsCode || r.insCode || r.instrumentID || compactKey(r.symbol));
    if(seen.has(k)) continue;
    seen.add(k);
    if(isRadarUniverse(r)) out.push(r);
  }
  return out;
}


/* ===== v6.64 FINAL OVERRIDE: ALERT LOGIC / LABEL FIX =====
   Key idea:
   - Instant alerts are update-to-update DELTAS, not cumulative daily totals.
   - A real-money alert must not be shown as if it changed market net big money.
   - For real alerts, the main cumulative metric is today's real-money net for that symbol.
   - For big alerts, the main cumulative metric is today's big-money net for that symbol.
*/
function v664IsBigAlert(a){
  const t = String(a?.type || '');
  return t === 'bigBuy' || t === 'bigSell';
}
function v664IsRealAlert(a){
  const t = String(a?.type || '');
  return t === 'realBuy' || t === 'realSell';
}
function v664AlertKindLabel(a){ return v664IsBigAlert(a) ? 'پول درشت' : 'پول حقیقی'; }
function v664AlertSideLabel(a){ return Number(a?.amountB || 0) >= 0 ? 'خرید' : 'فروش'; }
function v664EnsureAlertTitles(){
  try{
    document.querySelectorAll('.alertPanelSplit h2, #alerts .panel h2').forEach(h => {
      if(!h) return;
      if(h.closest('.alertPanelSplit')) h.innerHTML = 'خرید/فروش درشت لحظه‌ای بالای ۲ میلیارد تومان <span class="unitHint">تعداد کل: <b id="alertCount">'+ fa((state.alerts||[]).filter(a=>globalThis.RadarAlertPolicy?.qualifies(a)).length) +'</b></span>';
      else if(h.closest('#alerts')) h.textContent = 'خرید/فروش درشت لحظه‌ای بالای ۲ میلیارد تومان';
    });
  }catch(e){}
}
function renderAlerts(){
  v664EnsureAlertTitles();
  const alerts = (state.alerts || []).filter(a => globalThis.RadarAlertPolicy?.qualifies(a));
  const count = $('alertCount');
  if(count) count.textContent = fa(alerts.length);

  const buyAlerts = alerts.filter(a => Number(a.amountB || 0) >= 0).slice(0, 40);
  const sellAlerts = alerts.filter(a => Number(a.amountB || 0) < 0).slice(0, 40);

  [$('alertBuyCount'), $('alertBuyCount2')].filter(Boolean).forEach(e => e.textContent = fa(buyAlerts.length));
  [$('alertSellCount'), $('alertSellCount2')].filter(Boolean).forEach(e => e.textContent = fa(sellAlerts.length));

  const emptyAll = '<div class="empty">هنوز خرید یا فروش درشت لحظه‌ای بالای ۲ میلیارد تومان ثبت نشده است. دریافت اول فقط خط پایه می‌سازد.</div>';
  const emptyBuy = '<div class="empty">فعلاً خرید درشت لحظه‌ای بالای ۲ میلیارد تومان ثبت نشده است.</div>';
  const emptySell = '<div class="empty">فعلاً فروش درشت لحظه‌ای بالای ۲ میلیارد تومان ثبت نشده است.</div>';

  [$('liveAlerts'), $('liveAlerts2')].filter(Boolean).forEach(box => box.innerHTML = alerts.length ? renderAlertItems(alerts.slice(0,50), false) : emptyAll);
  [$('liveBuyAlerts'), $('liveBuyAlerts2')].filter(Boolean).forEach(box => box.innerHTML = buyAlerts.length ? renderAlertItems(buyAlerts, true) : emptyBuy);
  [$('liveSellAlerts'), $('liveSellAlerts2')].filter(Boolean).forEach(box => box.innerHTML = sellAlerts.length ? renderAlertItems(sellAlerts, true) : emptySell);
}
function renderAlertItems(list, compact=false){
  return list.map(a => {
    const buy = Number(a.amountB || 0) >= 0;
    const typeClass = buy ? 'pos' : 'neg';
    const time = new Date(a.time).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const href = a.boardUrl || '#';
    const icon = buy ? '🟢' : '🔴';
    const cum = alertCumulativeSnapshot(a);
    const isBig = v664IsBigAlert(a);
    const kind = v664AlertKindLabel(a);
    const side = v664AlertSideLabel(a);
    const mainDelta = isBig ? Number(a.dBig || 0) : Number(a.dReal || 0);
    const otherDelta = isBig ? Number(a.dReal || 0) : Number(a.dBig || 0);
    const cumMain = isBig ? Number(cum.big || 0) : Number(cum.real || 0);
    const cumOther = isBig ? Number(cum.real || 0) : Number(cum.big || 0);
    const cumMainLabel = isBig ? 'خالص درشت امروز نماد' : 'خالص حقیقی امروز نماد';
    const otherLabel = isBig ? 'پول حقیقی' : 'پول درشت';
    const title = `${side} ${kind} لحظه‌ای بالای ۲ میلیارد تومان ${a.symbol || ''}`;
    const commonInfo = `${time} | گروه: ${esc(a.group||'نامشخص')} | آخرین ${pct(a.lastPercent)} | پایانی ${pct(a.closePercent)}`;
    const note = isBig ? 'این رخداد در خالص پول درشت اثر دارد.' : 'این رخداد حقیقی است؛ تا وقتی سرانه از آستانه درشت عبور نکند، خالص پول درشت را تغییر نمی‌دهد.';
    if(compact){
      return `<div class="alertItem compact ${buy?'buy':'sell'}">
        <div class="alertMain"><b>${icon} ${esc(title)}</b><small>${commonInfo}</small><small class="unitHint">${esc(note)}</small></div>
        <div class="alertMetrics">
          <span class="metric ${typeClass}"><b>${moneyUnit(mainDelta)}</b><small>تغییر ${kind}</small></span>
          <span class="metric ${cls(cumMain)}"><b>${moneyUnit(cumMain)}</b><small>${cumMainLabel}</small></span>
          <span class="metric ${cls(otherDelta)}"><b>${moneyUnit(otherDelta)}</b><small>تغییر ${otherLabel}</small></span>
        </div>
        <a class="tsetmcLink" target="_blank" rel="noopener noreferrer" href="${esc(href)}">تابلو</a>
      </div>`;
    }
    const cumDetail = `خرید درشت کل: ${moneyUnit(cum.bigBuy)} / فروش درشت کل: ${moneyUnit(cum.bigSell)}<br>خالص درشت نماد: ${moneyUnit(cum.big)} | خالص حقیقی نماد: ${moneyUnit(cum.real)} | ارزش معاملات: ${moneyUnit(cum.value)}`;
    return `<div class="alertItem ${buy?'buy':'sell'}">
      <div class="alertMain"><b>${icon} ${esc(title)}</b><small>${commonInfo}</small><small class="unitHint">${esc(note)}</small></div>
      <div class="alertAmount ${typeClass}">${moneyUnit(mainDelta)}<small>تغییر همین آپدیت<br>${kind}</small></div>
      <div class="alertAmount ${cls(cumMain)}"><b>${moneyUnit(cumMain)}</b><small>${cumMainLabel}<br>${cumDetail}</small></div>
      <a class="tsetmcLink" target="_blank" rel="noopener noreferrer" href="${esc(href)}">تابلو</a>
    </div>`;
  }).join('');
}
function renderAll(){
  try{ renderReport(); }catch(e){ state.debug.push({stage:'renderReport-error',message:e.message||String(e)}); }
  try{ renderAllTables(); }catch(e){ state.debug.push({stage:'renderTables-error',message:e.message||String(e)}); }
  try{ renderGroups(); }catch(e){ state.debug.push({stage:'renderGroups-error',message:e.message||String(e)}); }
  try{ renderAlerts(); }catch(e){ state.debug.push({stage:'renderAlerts-error',message:e.message||String(e)}); }
  try{ renderCharts(); }catch(e){ state.debug.push({stage:'renderCharts-error',message:e.message||String(e)}); }
  try{ renderDailyValueStatus(); }catch(e){}
  try{ syncIntervalSelect(); }catch(e){}
}


/* ===== v6.66 FINAL OVERRIDE: BIG MONEY INSTANT/DAILY CONSISTENCY =====
   Fix:
   - A symbol could appear in instant big-money alerts but not in the top big-money cards,
     because alerts were update-to-update deltas while cards were sorted only by daily net.
   - Dashboard now surfaces recent big-money deltas inside the big-money cards and table.
   - Daily net remains daily net; instant delta is shown separately so the two meanings are not mixed.
*/
function v666AlertKey(a){ return String(a?.key || a?.numericInsCode || a?.insCode || a?.instrumentID || compactKey(a?.symbol || '') || ''); }
function v666RowKey(r){ return String(r?.numericInsCode || r?.insCode || r?.instrumentID || compactKey(r?.symbol || '') || ''); }
function v666LatestBigAlertMap(){
  const map = new Map();
  for(const a of (state.alerts || [])){
    if(!v664IsBigAlert(a)) continue;
    const k = v666AlertKey(a);
    if(!k) continue;
    const prev = map.get(k);
    if(!prev || Number(a.time || 0) > Number(prev.time || 0)) map.set(k, a);
  }
  return map;
}
function v666AttachInstantBig(row, latestMap){
  const a = latestMap.get(v666RowKey(row));
  const d = a ? Number(a.dBig || a.amountB || 0) : 0;
  return { ...row, _latestBigAlert: a || null, _instantBigB: Number.isFinite(d) ? d : 0 };
}
function v666BigScore(row){
  return Math.max(Math.abs(Number(row.bigMoneyB || 0)), Math.abs(Number(row._instantBigB || 0)));
}
function v666BigDirectionValue(row){
  const inst = Number(row._instantBigB || 0);
  const daily = Number(row.bigMoneyB || 0);
  return Math.abs(inst) > Math.abs(daily) ? inst : daily;
}
function v666BigListRows(rows, dir){
  const latest = v666LatestBigAlertMap();
  const attached = (rows || []).map(r => v666AttachInstantBig(r, latest));
  const filtered = attached.filter(r => {
    const daily = Number(r.bigMoneyB || 0);
    const inst = Number(r._instantBigB || 0);
    return dir > 0 ? (daily > 0 || inst > 0) : (daily < 0 || inst < 0);
  });
  return filtered.sort((a,b) => v666BigScore(b) - v666BigScore(a)).slice(0,12);
}
function v666BigMain(row){
  const inst = Number(row._instantBigB || 0);
  const daily = Number(row.bigMoneyB || 0);
  if(Math.abs(inst) > Math.abs(daily)) return `لحظه‌ای ${moneyUnit(inst)}`;
  return moneyUnit(daily);
}
function v666BigSub(row, dir){
  const inst = Number(row._instantBigB || 0);
  const daily = Number(row.bigMoneyB || 0);
  const avg = dir > 0 ? row.buyAvgOrderB : row.sellAvgOrderB;
  const power = dir > 0 ? row.buyPower : row.sellPower;
  const parts = [];
  if(inst) parts.push(`تغییر لحظه‌ای ${moneyUnit(inst)}`);
  parts.push(`خالص امروز ${moneyUnit(daily)}`);
  parts.push(`سرانه ${moneyUnit(avg)}`);
  parts.push(`قدرت ${nf(power)}×`);
  return parts.join(' | ');
}
function v666SortBigRows(rows, mode){
  const latest = v666LatestBigAlertMap();
  const attached = (rows || []).map(r => v666AttachInstantBig(r, latest));
  if(mode === 'bigIn') return attached.sort((a,b)=>Math.max(Number(b.bigMoneyB||0),Number(b._instantBigB||0))-Math.max(Number(a.bigMoneyB||0),Number(a._instantBigB||0)));
  if(mode === 'bigOut') return attached.sort((a,b)=>Math.min(Number(a.bigMoneyB||0),Number(a._instantBigB||0))-Math.min(Number(b.bigMoneyB||0),Number(b._instantBigB||0)));
  if(mode === 'bigAbs') return attached.sort((a,b)=>v666BigScore(b)-v666BigScore(a));
  return attached.sort(sorter(mode));
}
function v666RenderBigMoneyCell(x){
  const inst = Number(x._instantBigB || 0);
  const daily = Number(x.bigMoneyB || 0);
  const extra = inst ? `<br><small class="${cls(inst)}">تغییر لحظه‌ای پول درشت ${moneyUnit(inst)}</small>` : '';
  return `<b>${moneyUnit(daily)}</b>${extra}<br><small>خرید درشت ${moneyUnit(x.bigBuyB)} / فروش درشت ${moneyUnit(x.bigSellB)} | خام کانال ${moneyUnit(x.smtRawNetB||0)}</small>`;
}
function renderReport(){
  const rows = v662MarketRows(state.rows || []);
  const g = summarizeRows(rows);
  if($('mTotal')) $('mTotal').textContent = fa(g.count);
  if($('mClient')) $('mClient').textContent = fa(state.clientRows || 0);
  if($('mValue')) $('mValue').textContent = moneyUnit(g.valueB);
  setTextClass('mRealMoney', moneyUnit(g.realMoneyB), cls(g.realMoneyB));
  setTextClass('mBigMoney', moneyUnit(g.bigMoneyB), cls(g.bigMoneyB));
  if($('mPercent')) $('mPercent').textContent = `${pct(g.lastPercent)} / ${pct(g.closePercent)}`;
  if($('mBattle')) $('mBattle').textContent = `${fa(rows.filter(x=>x.gap>0).length)} خرید / ${fa(rows.filter(x=>x.gap<0).length)} فروش`;
  if($('dataHealth')) $('dataHealth').innerHTML = `<b>وضعیت:</b> ${rows.length ? 'به‌روز' : 'بدون داده'} | <b>نمادها:</b> ${fa(rows.length)} | <b>حقیقی/حقوقی:</b> ${pct((state.dataQuality?.clientCoverage||0)*100)} | <b>بروزرسانی:</b> ${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString('fa-IR') : '—'}`;
  if($('unitGuide')) $('unitGuide').innerHTML = 'واحد مبالغ: تومان | پول حقیقی = ارزش خرید حقیقی − ارزش فروش حقیقی | پول درشت روزانه و تغییر لحظه‌ای جدا نمایش داده می‌شوند.';
  const bigInRows = v666BigListRows(rows, +1);
  const bigOutRows = v666BigListRows(rows, -1);
  mini('topBigIn', bigInRows, x=>v666BigMain(x), x=>v666BigSub(x,+1));
  mini('topBigOut', bigOutRows, x=>v666BigMain(x), x=>v666BigSub(x,-1));
  mini('topRealIn', rows.filter(x=>x.realMoneyB>0).sort((a,b)=>b.realMoneyB-a.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت امروز ${moneyUnit(x.bigMoneyB)} | قدرت خرید ${nf(x.buyPower)}×`);
  mini('topRealOut', rows.filter(x=>x.realMoneyB<0).sort((a,b)=>a.realMoneyB-b.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت امروز ${moneyUnit(x.bigMoneyB)} | قدرت فروش ${nf(x.sellPower)}×`);
  mini('topBattleBuy', rows.filter(x=>x.gap>0).sort((a,b)=>b.gap-a.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)}`);
  mini('topBattleSell', rows.filter(x=>x.gap<0).sort((a,b)=>a.gap-b.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)}`);
  if(typeof updateAllGroupSelects === 'function') updateAllGroupSelects(rows);
}
function renderBigMoney(){
  try{ ensureBigTrendHeader(); }catch(e){}
  let rows = filteredBaseRows('bigSearchInput');
  const g = $('bigGroupSelect')?.value || 'all';
  if(g !== 'all') rows = rows.filter(x => x.assetGroup === g);
  const mode = $('bigModeSelect')?.value || 'bigIn';
  rows = v666SortBigRows(rows, mode);
  const body = $('bigRows'); if(!body) return;
  body.innerHTML = rows.length ? rows.slice(0,1200).map(x=>{
    const h = typeof hotForRow === 'function' ? hotForRow(x) : null;
    return `<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td>`+
      `<td><span class="badge">${esc(x.assetGroup||'')}</span></td>`+
      `<td class="${cls(x.bigMoneyB)}">${v666RenderBigMoneyCell(x)}</td>`+
      `<td>${typeof miniBigTrendSpark === 'function' ? miniBigTrendSpark(x) : ''}</td>`+
      `<td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td>`+
      (typeof hotMoneyCell === 'function' ? hotMoneyCell(h) : '<td>—</td><td>—</td><td>—</td>')+
      `<td>${moneyUnit(x.buyAvgOrderB)}</td><td>${moneyUnit(x.sellAvgOrderB)}</td><td>${nf(x.buyPower)}×</td><td>${nf(x.sellPower)}×</td><td>${pct(x.gap)}</td></tr>`;
  }).join('') : '<tr><td colspan="13" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
  if(typeof renderHotMoneyStatus === 'function') renderHotMoneyStatus();
}
function renderAll(){
  try{ renderReport(); }catch(e){ state.debug.push({stage:'renderReport-error-v666',message:e.message||String(e)}); }
  try{ renderAllTables(); }catch(e){ state.debug.push({stage:'renderTables-error-v666',message:e.message||String(e)}); }
  try{ renderGroups(); }catch(e){ state.debug.push({stage:'renderGroups-error-v666',message:e.message||String(e)}); }
  try{ renderAlerts(); }catch(e){ state.debug.push({stage:'renderAlerts-error-v666',message:e.message||String(e)}); }
  try{ renderCharts(); }catch(e){ state.debug.push({stage:'renderCharts-error-v666',message:e.message||String(e)}); }
  try{ renderDailyValueStatus(); }catch(e){}
  try{ syncIntervalSelect(); }catch(e){}
}

/* ===== v6.67 FINAL OVERRIDE: DIRECTIONAL BIG-MONEY LIST FIX =====
   Fix:
   - In v6.66, a row with a large negative daily big-money value and a small positive instant delta
     could appear in the "big inflow" card, but the card displayed the negative daily value.
   - Inflow cards must only show the positive selected value; outflow cards must only show the negative selected value.
   - The daily net and instant delta remain separate, but ranking/display now use the same directional value.
*/
function v667DirectionalBigValue(row, dir){
  const daily = Number(row?.bigMoneyB || 0);
  const inst = Number(row?._instantBigB || 0);
  if(dir > 0){
    const vals = [];
    if(daily > 0) vals.push({source:'daily', value:daily});
    if(inst > 0) vals.push({source:'instant', value:inst});
    if(!vals.length) return {source:'none', value:0};
    vals.sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));
    return vals[0];
  }
  const vals = [];
  if(daily < 0) vals.push({source:'daily', value:daily});
  if(inst < 0) vals.push({source:'instant', value:inst});
  if(!vals.length) return {source:'none', value:0};
  vals.sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));
  return vals[0];
}
function v667BigListRows(rows, dir){
  const latest = v666LatestBigAlertMap();
  const attached = (rows || []).map(r => v666AttachInstantBig(r, latest));
  return attached
    .map(r => ({...r, _displayBig: v667DirectionalBigValue(r, dir)}))
    .filter(r => dir > 0 ? r._displayBig.value > 0 : r._displayBig.value < 0)
    .sort((a,b)=>Math.abs(b._displayBig.value)-Math.abs(a._displayBig.value))
    .slice(0,12);
}
function v667BigMain(row){
  const d = row?._displayBig || {source:'daily', value:Number(row?.bigMoneyB || 0)};
  return d.source === 'instant' ? `لحظه‌ای ${moneyUnit(d.value)}` : moneyUnit(d.value);
}
function v667BigSub(row, dir){
  const inst = Number(row._instantBigB || 0);
  const daily = Number(row.bigMoneyB || 0);
  const avg = dir > 0 ? row.buyAvgOrderB : row.sellAvgOrderB;
  const power = dir > 0 ? row.buyPower : row.sellPower;
  const selected = row?._displayBig;
  const parts = [];
  if(selected?.source === 'instant') parts.push('مبنای رتبه: تغییر لحظه‌ای');
  if(selected?.source === 'daily') parts.push('مبنای رتبه: خالص امروز');
  if(inst) parts.push(`تغییر لحظه‌ای ${moneyUnit(inst)}`);
  parts.push(`خالص امروز ${moneyUnit(daily)}`);
  parts.push(`سرانه ${moneyUnit(avg)}`);
  parts.push(`قدرت ${nf(power)}×`);
  return parts.join(' | ');
}
function v667AttachRows(rows){
  const latest = v666LatestBigAlertMap();
  return (rows || []).map(r => v666AttachInstantBig(r, latest));
}
function v667SortBigRows(rows, mode){
  const attached = v667AttachRows(rows);
  if(mode === 'bigIn'){
    return attached
      .map(r=>({...r, _displayBig:v667DirectionalBigValue(r,+1)}))
      .filter(r=>r._displayBig.value>0)
      .sort((a,b)=>b._displayBig.value-a._displayBig.value);
  }
  if(mode === 'bigOut'){
    return attached
      .map(r=>({...r, _displayBig:v667DirectionalBigValue(r,-1)}))
      .filter(r=>r._displayBig.value<0)
      .sort((a,b)=>a._displayBig.value-b._displayBig.value);
  }
  if(mode === 'bigAbs'){
    return attached.sort((a,b)=>Math.max(Math.abs(Number(b.bigMoneyB||0)),Math.abs(Number(b._instantBigB||0))) - Math.max(Math.abs(Number(a.bigMoneyB||0)),Math.abs(Number(a._instantBigB||0))));
  }
  return attached.sort(sorter(mode));
}
function v667RenderBigMoneyCell(x){
  const inst = Number(x._instantBigB || 0);
  const daily = Number(x.bigMoneyB || 0);
  const selected = x._displayBig && x._displayBig.source !== 'none'
    ? `<br><small class="${cls(x._displayBig.value)}">مبنای فیلتر: ${x._displayBig.source === 'instant' ? 'لحظه‌ای' : 'امروز'} ${moneyUnit(x._displayBig.value)}</small>`
    : '';
  const extra = inst ? `<br><small class="${cls(inst)}">تغییر لحظه‌ای پول درشت ${moneyUnit(inst)}</small>` : '';
  return `<b>${moneyUnit(daily)}</b>${selected}${extra}<br><small>خرید درشت ${moneyUnit(x.bigBuyB)} / فروش درشت ${moneyUnit(x.bigSellB)} | خام کانال ${moneyUnit(x.smtRawNetB||0)}</small>`;
}
function renderReport(){
  const rows = v662MarketRows(state.rows || []);
  const g = summarizeRows(rows);
  if($('mTotal')) $('mTotal').textContent = fa(g.count);
  if($('mClient')) $('mClient').textContent = fa(state.clientRows || 0);
  if($('mValue')) $('mValue').textContent = moneyUnit(g.valueB);
  setTextClass('mRealMoney', moneyUnit(g.realMoneyB), cls(g.realMoneyB));
  setTextClass('mBigMoney', moneyUnit(g.bigMoneyB), cls(g.bigMoneyB));
  if($('mPercent')) $('mPercent').textContent = `${pct(g.lastPercent)} / ${pct(g.closePercent)}`;
  if($('mBattle')) $('mBattle').textContent = `${fa(rows.filter(x=>x.gap>0).length)} خرید / ${fa(rows.filter(x=>x.gap<0).length)} فروش`;
  if($('dataHealth')) $('dataHealth').innerHTML = `<b>وضعیت:</b> ${rows.length ? 'به‌روز' : 'بدون داده'} | <b>نمادها:</b> ${fa(rows.length)} | <b>حقیقی/حقوقی:</b> ${pct((state.dataQuality?.clientCoverage||0)*100)} | <b>بروزرسانی:</b> ${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString('fa-IR') : '—'}`;
  if($('unitGuide')) $('unitGuide').innerHTML = 'واحد مبالغ: تومان | پول حقیقی = ارزش خرید حقیقی − ارزش فروش حقیقی | ورود/خروج پول درشت فقط با همان جهت مثبت/منفی نمایش داده می‌شود.';
  const bigInRows = v667BigListRows(rows, +1);
  const bigOutRows = v667BigListRows(rows, -1);
  mini('topBigIn', bigInRows, x=>v667BigMain(x), x=>v667BigSub(x,+1));
  mini('topBigOut', bigOutRows, x=>v667BigMain(x), x=>v667BigSub(x,-1));
  mini('topRealIn', rows.filter(x=>x.realMoneyB>0).sort((a,b)=>b.realMoneyB-a.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت امروز ${moneyUnit(x.bigMoneyB)} | قدرت خرید ${nf(x.buyPower)}×`);
  mini('topRealOut', rows.filter(x=>x.realMoneyB<0).sort((a,b)=>a.realMoneyB-b.realMoneyB).slice(0,12), x=>moneyUnit(x.realMoneyB), x=>`پول درشت امروز ${moneyUnit(x.bigMoneyB)} | قدرت فروش ${nf(x.sellPower)}×`);
  mini('topBattleBuy', rows.filter(x=>x.gap>0).sort((a,b)=>b.gap-a.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)}`);
  mini('topBattleSell', rows.filter(x=>x.gap<0).sort((a,b)=>a.gap-b.gap).slice(0,12), x=>pct(x.gap), x=>`آخرین ${pct(x.lastPercent)} | پایانی ${pct(x.closePercent)}`);
  if(typeof updateAllGroupSelects === 'function') updateAllGroupSelects(rows);
}
function renderBigMoney(){
  try{ ensureBigTrendHeader(); }catch(e){}
  let rows = filteredBaseRows('bigSearchInput');
  const g = $('bigGroupSelect')?.value || 'all';
  if(g !== 'all') rows = rows.filter(x => x.assetGroup === g);
  const mode = $('bigModeSelect')?.value || 'bigIn';
  rows = v667SortBigRows(rows, mode);
  const body = $('bigRows'); if(!body) return;
  body.innerHTML = rows.length ? rows.slice(0,1200).map(x=>{
    const h = typeof hotForRow === 'function' ? hotForRow(x) : null;
    return `<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td>`+
      `<td><span class="badge">${esc(x.assetGroup||'')}</span></td>`+
      `<td class="${cls(x._displayBig?.value || x.bigMoneyB)}">${v667RenderBigMoneyCell(x)}</td>`+
      `<td>${typeof miniBigTrendSpark === 'function' ? miniBigTrendSpark(x) : ''}</td>`+
      `<td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td>`+
      (typeof hotMoneyCell === 'function' ? hotMoneyCell(h) : '<td>—</td><td>—</td><td>—</td>')+
      `<td>${moneyUnit(x.buyAvgOrderB)}</td><td>${moneyUnit(x.sellAvgOrderB)}</td><td>${nf(x.buyPower)}×</td><td>${nf(x.sellPower)}×</td><td>${pct(x.gap)}</td></tr>`;
  }).join('') : '<tr><td colspan="13" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
  if(typeof renderHotMoneyStatus === 'function') renderHotMoneyStatus();
}


/* ===== v6.68: FLOW TOTAL CARDS =====
   اضافه‌شده: جمع ورود و جمع خروج پول حقیقی و پول درشت، جدا از خالص.
   فرمول‌ها دست نخورده‌اند؛ فقط جمع‌های مثبت/منفی همان مقادیر موجود هر نماد نمایش داده می‌شوند.
*/
(function(){
  const previousRenderReport = typeof renderReport === 'function' ? renderReport : null;
  function finiteB(v){
    const n = Number(v || 0);
    return Number.isFinite(n) ? n : 0;
  }
  function calcFlowTotals(rows){
    const r = Array.isArray(rows) ? rows : [];
    let realIn = 0, realOut = 0, bigIn = 0, bigOut = 0;
    for(const x of r){
      const real = finiteB(x.realMoneyB);
      const big = finiteB(x.bigMoneyB);
      if(real > 0) realIn += real; else if(real < 0) realOut += Math.abs(real);
      if(big > 0) bigIn += big; else if(big < 0) bigOut += Math.abs(big);
    }
    return { realIn, realOut, realNet: realIn - realOut, bigIn, bigOut, bigNet: bigIn - bigOut };
  }
  function ensureFlowTotalCards(){
    if(document.getElementById('flowTotalCards')) return;
    const base = document.querySelector('#radar .cards');
    if(!base || !base.parentNode) return;
    const box = document.createElement('div');
    box.id = 'flowTotalCards';
    box.className = 'cards flowTotalCards';
    box.innerHTML = `
      <div class="card flowCard"><small>مجموع ورود پول درشت</small><b id="mBigInTotal" class="pos">۰</b></div>
      <div class="card flowCard"><small>مجموع خروج پول درشت</small><b id="mBigOutTotal" class="neg">۰</b></div>
      <div class="card flowCard"><small>مجموع ورود پول حقیقی</small><b id="mRealInTotal" class="pos">۰</b></div>
      <div class="card flowCard"><small>مجموع خروج پول حقیقی</small><b id="mRealOutTotal" class="neg">۰</b></div>`;
    base.insertAdjacentElement('afterend', box);
  }
  function setFlowText(id, val, klass){
    const e = document.getElementById(id);
    if(!e) return;
    e.textContent = moneyUnit(val);
    e.className = klass || '';
  }
  function flowHintHtml(s){
    return `کنترل جمع‌ها: درشت ${moneyUnit(s.bigIn)} − ${moneyUnit(s.bigOut)} = <b class="${cls(s.bigNet)}">${moneyUnit(s.bigNet)}</b> | حقیقی ${moneyUnit(s.realIn)} − ${moneyUnit(s.realOut)} = <b class="${cls(s.realNet)}">${moneyUnit(s.realNet)}</b>`;
  }
  function renderFlowTotals(rows){
    ensureFlowTotalCards();
    const s = calcFlowTotals(rows);
    setFlowText('mBigInTotal', s.bigIn, 'pos');
    setFlowText('mBigOutTotal', s.bigOut, 'neg');
    setFlowText('mRealInTotal', s.realIn, 'pos');
    setFlowText('mRealOutTotal', s.realOut, 'neg');
    const hint = document.getElementById('flowTotalsHint');
    if(hint){
      hint.innerHTML = flowHintHtml(s);
    }
    const unit = document.getElementById('unitGuide');
    if(unit && !document.getElementById('flowTotalsHint')){
      const div = document.createElement('div');
      div.id = 'flowTotalsHint';
      div.className = 'unitHint flowTotalsHint';
      div.innerHTML = flowHintHtml(s);
      unit.insertAdjacentElement('afterend', div);
    }
  }
  renderReport = function(){
    if(previousRenderReport) previousRenderReport();
    const rows = (typeof v662MarketRows === 'function' ? v662MarketRows(state.rows || []) : (state.rows || []));
    renderFlowTotals(rows);
  };
})();

/* ===== v7.2 FINAL OVERRIDE: PER-SYMBOL REAL/BIG/BUYER-POWER TRENDS =====
   - One intraday trend store per symbol.
   - Tracks cumulative real-money net, estimated big-money net, and buyer power.
   - Trend points are recorded ONLY during the main 09:00-12:30 session and only for
     fresh rows with valid ClientType data; pre-open/old data cannot build a trend.
   - First point is a baseline; direction needs at least two valid points.
*/
function trendDayKey(ts = Date.now()){
  try{
    const sess = globalThis.RadarMarketSession?.current?.(new Date(ts));
    if(sess?.dateKey) return String(sess.dateKey);
    return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ts)).replace(/-/g,'');
  }catch(e){ return ''; }
}

function addSymbolBigTrend(rows){
  const session = globalThis.RadarMarketSession?.current?.() || null;
  if(!session || !globalThis.RadarMarketSession?.canGenerateAlerts?.(session)) return;
  state.symbolBigTrend = state.symbolBigTrend && typeof state.symbolBigTrend === 'object' ? state.symbolBigTrend : {};
  const now = Date.now();
  const day = String(session.dateKey || trendDayKey(now));
  const minGapMs = Math.max(10000, Math.min(45000, Number(getMonitorIntervalMs?.() || DEFAULT_MONITOR_INTERVAL_MS || 1000) * 10));
  const alive = new Set();
  for(const r of rows || []){
    if(!r?.liveSessionData || !r?.hasClient) continue;
    const k = alertKey(r);
    if(!k) continue;
    alive.add(k);
    const point = {
      t: now, d: day,
      b: Number.isFinite(Number(r.bigMoneyB)) ? Number(r.bigMoneyB) : 0,
      r: Number.isFinite(Number(r.realMoneyB)) ? Number(r.realMoneyB) : 0,
      p: Number.isFinite(Number(r.buyPower)) ? Number(r.buyPower) : 0,
      s: Number.isFinite(Number(r.sellPower)) ? Number(r.sellPower) : 0,
      bb: Number.isFinite(Number(r.bigBuyB)) ? Number(r.bigBuyB) : 0,
      bs: Number.isFinite(Number(r.bigSellB)) ? Number(r.bigSellB) : 0
    };
    const old = Array.isArray(state.symbolBigTrend[k]) ? state.symbolBigTrend[k].filter(x=>x && String(x.d)===day) : [];
    state.symbolBigTrend[k] = globalThis.RadarSymbolTrend?.append
      ? globalThis.RadarSymbolTrend.append(old, point, {minGapMs,max:180})
      : [...old,point].slice(-180);
  }
  // Keep only today's points. Do not delete temporarily missing symbols during the session;
  // a halted symbol can resume later and its earlier valid trend remains useful.
  for(const k of Object.keys(state.symbolBigTrend)){
    const sameDay = Array.isArray(state.symbolBigTrend[k]) ? state.symbolBigTrend[k].filter(x=>x && String(x.d)===day) : [];
    if(!sameDay.length) delete state.symbolBigTrend[k];
    else state.symbolBigTrend[k] = sameDay;
  }
}

function bigTrendForRow(row){
  const k = alertKey(row);
  const day = trendDayKey();
  const hist = (state.symbolBigTrend && state.symbolBigTrend[k]) ? state.symbolBigTrend[k] : [];
  return Array.isArray(hist) ? hist.filter(p=>p && String(p.d)===String(day)).sort((a,b)=>Number(a.t||0)-Number(b.t||0)) : [];
}

function v720MetricInfo(hist,key,kind){
  if(globalThis.RadarSymbolTrend?.metricInfo) return globalThis.RadarSymbolTrend.metricInfo(hist,key,kind);
  return {points:0,current:0,fullDelta:0,recentDelta:0,direction:0,label:'بدون داده'};
}
function v720Arrow(dir){ return dir>0 ? '↗' : dir<0 ? '↘' : '→'; }
function v720MoneyDelta(v){
  const n = Number(v||0);
  return `${n>0?'+':''}${moneyUnit(n)}`;
}
function v720Power(v){
  const n=Number(v||0);
  return Number.isFinite(n) && n>0 ? `${nf(n)}×` : '—';
}
function v720PowerDelta(v){
  const n=Number(v||0);
  return Number.isFinite(n) ? `${n>0?'+':''}${nf(n)}×` : '—';
}
function v720SparkSvg(hist,key,kind){
  const vals = (hist||[]).map(x=>Number(x?.[key])).filter(Number.isFinite);
  if(vals.length<2) return '<span class="trendNoLine">···</span>';
  const w=92,h=24,p=2;
  let min=Math.min(...vals), max=Math.max(...vals);
  if(kind==='money'){ min=Math.min(0,min); max=Math.max(0,max); }
  if(min===max){ min-=1; max+=1; }
  const span=max-min || 1;
  const xp=i=>p+i*((w-p*2)/Math.max(1,vals.length-1));
  const yp=v=>p+(h-p*2)-((v-min)/span)*(h-p*2);
  const pts=vals.map((v,i)=>`${xp(i).toFixed(1)},${yp(v).toFixed(1)}`).join(' ');
  const last=vals[vals.length-1], first=vals[0];
  const stroke = kind==='power' ? (last>=1 ? '#38bdf8' : '#f59e0b') : (last>=0 ? '#22c55e' : '#ef4444');
  const zero = kind==='money' && min<=0 && max>=0 ? `<line x1="${p}" y1="${yp(0).toFixed(1)}" x2="${w-p}" y2="${yp(0).toFixed(1)}" stroke="rgba(148,163,184,.35)" stroke-width=".7"/>` : '';
  return `<svg class="metricSpark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${zero}<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${xp(vals.length-1).toFixed(1)}" cy="${yp(last).toFixed(1)}" r="1.8" fill="${stroke}"/></svg>`;
}
function v720TrendMetric(hist,key,kind,label){
  const info=v720MetricInfo(hist,key,kind);
  if(info.points<2){
    const current = kind==='power' ? v720Power(info.current) : moneyUnit(info.current);
    return `<div class="symbolTrendMetric pending"><span class="trendLabel">${label}</span>${v720SparkSvg(hist,key,kind)}<span class="trendValue">${current}</span><small>در حال ثبت</small></div>`;
  }
  const delta = kind==='power' ? v720PowerDelta(info.recentDelta) : v720MoneyDelta(info.recentDelta);
  const current = kind==='power' ? v720Power(info.current) : moneyUnit(info.current);
  const tone = info.direction>0 ? 'pos' : info.direction<0 ? 'neg' : 'muted';
  return `<div class="symbolTrendMetric"><span class="trendLabel">${label}</span>${v720SparkSvg(hist,key,kind)}<span class="trendValue ${tone}">${v720Arrow(info.direction)} ${current}</span><small class="${tone}" title="${esc(info.label||'')}">اخیر ${delta}</small></div>`;
}
function miniBigTrendSpark(row){
  const hist=bigTrendForRow(row);
  if(!hist.length) return '<div class="multiSymbolTrend emptyTrend"><small>پس از شروع بازار و دو ثبت معتبر، روند ساخته می‌شود</small></div>';
  const start=timeShort(hist[0]?.t), end=timeShort(hist[hist.length-1]?.t);
  return `<div class="multiSymbolTrend" title="روند از زمان باز بودن داشبورد ثبت می‌شود؛ فقط داده معتبر جلسه اصلی بازار.">
    ${v720TrendMetric(hist,'r','money','حقیقی')}
    ${v720TrendMetric(hist,'b','money','درشت')}
    ${v720TrendMetric(hist,'p','power','قدرت خرید')}
    <div class="trendTime">${esc(start)} ← ${esc(end)} | ${fa(hist.length)} نقطه</div>
  </div>`;
}

function ensureBigTrendHeader(){
  const tr=document.querySelector('#bigmoney thead tr');
  if(!tr) return;
  let th=tr.querySelector('th[data-big-trend]');
  if(!th){ th=document.createElement('th'); th.dataset.bigTrend='1'; tr.insertBefore(th,tr.children[3]||null); }
  th.textContent='روند حقیقی / درشت / قدرت خرید';
}
function v720EnsureSymbolTrendHeader(){
  const tr=document.querySelector('#symbols thead tr');
  if(!tr) return;
  let th=tr.querySelector('th[data-symbol-trend]');
  if(!th){ th=document.createElement('th'); th.dataset.symbolTrend='1'; tr.insertBefore(th,tr.children[11]||null); }
  th.textContent='روند حقیقی / درشت / قدرت خرید';
}

function symbolTr(x){
  return `<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td>`+
  `<td><span class="badge">${esc(x.assetGroup||'نامشخص')}</span><br><small>${esc(x.marketName||'')} | ${x.traded ? 'معامله‌شده' : 'بدون معامله/متوقف'} | قیمت: ${esc(x.priceSource||'—')}</small></td>`+
  `<td class="numCell">${priceRial(x.lastPrice)}</td><td class="numCell">${priceRial(x.closePrice)}</td>`+
  `<td class="${cls(x.lastPercent)}">${pct(x.lastPercent)}</td><td class="${cls(x.closePercent)}">${pct(x.closePercent)}</td>`+
  `<td><span class="badge battleBadge ${x.battle.tone}">${esc(x.battle.label)}</span><br><small class="${cls(x.gap)}">${pct(x.gap)}</small></td>`+
  `<td class="${cls(x.bigMoneyB)}"><b>${moneyUnit(x.bigMoneyB)}</b></td><td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td>`+
  `<td>خرید: ${moneyUnit(x.buyAvgOrderB)}<br><small>فروش: ${moneyUnit(x.sellAvgOrderB)}</small></td><td>${nf(x.buyPower)}× / ${nf(x.sellPower)}×</td>`+
  `<td>${miniBigTrendSpark(x)}</td><td>${moneyUnit(x.valueB)}</td></tr>`;
}
function renderSymbols(){
  v720EnsureSymbolTrendHeader();
  let rows=filteredBaseRows('searchInput');
  const g=$('groupSelect')?.value||'all'; if(g!=='all') rows=rows.filter(x=>x.assetGroup===g);
  const s=$('sortSelect')?.value||'bigIn'; rows.sort(sorter(s));
  const body=$('symbolRows'); if(!body) return;
  body.innerHTML=rows.length ? rows.slice(0,1200).map(symbolTr).join('') : '<tr><td colspan="13" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
}

function renderBigMoney(){
  ensureBigTrendHeader();
  let rows=filteredBaseRows('bigSearchInput');
  const g=$('bigGroupSelect')?.value||'all'; if(g!=='all') rows=rows.filter(x=>x.assetGroup===g);
  const mode=$('bigModeSelect')?.value||'bigIn';
  rows=typeof v667SortBigRows==='function' ? v667SortBigRows(rows,mode) : rows.sort(sorter(mode));
  const body=$('bigRows'); if(!body) return;
  body.innerHTML=rows.length ? rows.slice(0,1200).map(x=>{
    const h=typeof hotForRow==='function'?hotForRow(x):null;
    const bigCell=typeof v667RenderBigMoneyCell==='function'?v667RenderBigMoneyCell(x):`<b>${moneyUnit(x.bigMoneyB)}</b>`;
    return `<tr><td><b>${symbolLink(x)}</b><br><small>${esc(x.fullName||'')}</small></td>`+
      `<td><span class="badge">${esc(x.assetGroup||'')}</span></td>`+
      `<td class="${cls(x._displayBig?.value||x.bigMoneyB)}">${bigCell}</td>`+
      `<td>${miniBigTrendSpark(x)}</td>`+
      `<td class="${cls(x.realMoneyB)}">${moneyUnit(x.realMoneyB)}</td>`+
      (typeof hotMoneyCell==='function'?hotMoneyCell(h):'<td>—</td><td>—</td><td>—</td>')+
      `<td>${moneyUnit(x.buyAvgOrderB)}</td><td>${moneyUnit(x.sellAvgOrderB)}</td><td>${nf(x.buyPower)}×</td><td>${nf(x.sellPower)}×</td><td>${pct(x.gap)}</td></tr>`;
  }).join('') : '<tr><td colspan="13" class="empty">داده‌ای برای نمایش نیست.</td></tr>';
  if(typeof renderHotMoneyStatus==='function') renderHotMoneyStatus();
}
