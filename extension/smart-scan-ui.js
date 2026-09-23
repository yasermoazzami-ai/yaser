/* Smart scan page: daily shortlist built from normalized money flow (big + real),
   relative activity and relative strength/trend. Pure scoring lives in smart-scan.js. */
(() => {
  const SCAN_STORAGE_KEY = 'tsetmcRadar_smartScan_history_v1';
  const SCAN_MAX_SYMBOLS = 150;      // top symbols by today's value get history
  const SCAN_WORKERS = 4;
  const SCAN_HISTORY_DAYS = 60;
  const SCAN_FLOW_DAYS = 20;
  const SCAN_FALLBACK_FLOW_DAYS = 5;

  const S = globalThis.RadarSmartScan;
  if (!S) return;
  let hist = {};                     // key -> { dateKey, at, days:[...] }
  let busy = false, loaded = false, progress = { done: 0, total: 0 };

  function num(v){ const x = Number(v); return Number.isFinite(x) ? x : 0; }
  function keyOf(r){ return String(r?.numericInsCode || r?.insCode || '').trim(); }
  function todayKey(){ return globalThis.RadarMarketSession?.current?.()?.dateKey || ''; }
  function nowHms(){ return globalThis.RadarMarketSession?.parts?.()?.hms || 0; }

  async function loadStore(){
    if (loaded) return; loaded = true;
    try { const o = await chrome.storage.local.get([SCAN_STORAGE_KEY]); const h = o?.[SCAN_STORAGE_KEY]; if (h && typeof h === 'object') hist = h; } catch {}
  }
  async function saveStore(){ try { await chrome.storage.local.set({ [SCAN_STORAGE_KEY]: hist }); } catch {} }

  async function fetchDaily(code, today){
    const text = await fetchSilent(`https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/${encodeURIComponent(code)}/0`, 12000);
    const arr = extractDailyArrays(JSON.parse(text))[0] || [];
    const days = arr.map(o => {
      const key = String(val(o, ['dEven','DEven','date','dateEven','day']) || '').replace(/[^0-9]/g,'');
      const valueB = toNum(val(o, ['qTotCap','QTotCap','value','tradeValue','totalValue'])) / 1e9;
      const close = toNum(val(o, ['pClosing','PClosing','pDrCotVal','PDrCotVal','close','closePrice']));
      return key ? { key, valueB, close } : null;
    }).filter(d => d && d.close > 0 && d.valueB > 0 && (!today || d.key < today));
    const seen = new Set();
    return days.sort((a,b)=>Number(a.key)-Number(b.key)).filter(d => !seen.has(d.key) && seen.add(d.key)).slice(-SCAN_HISTORY_DAYS);
  }

  async function fetchFlowAll(code){
    // Full ClientType history in one call; returns {} when the endpoint is not available.
    try {
      const text = await fetchSilent(`https://cdn.tsetmc.com/api/ClientType/GetClientTypeHistory/${encodeURIComponent(code)}`, 12000);
      const out = {};
      for (const o of extractClientHistoryObjects(JSON.parse(text))) {
        const key = String(val(o, ['recDate','RecDate','dEven','DEven','date']) || '').replace(/[^0-9]/g,'');
        if (key.length === 8) out[key] = o;
      }
      return out;
    } catch { return {}; }
  }

  async function loadSymbol(r, today){
    const code = keyOf(r);
    if (!/^\d{8,}$/.test(code)) return;
    const days = await fetchDaily(code, today);
    if (!days.length) return;
    const flowTargets = days.slice(-SCAN_FLOW_DAYS);
    let flows = await fetchFlowAll(code);
    if (!Object.keys(flows).length && typeof fetchClientTypeForDay === 'function') {
      flows = {};
      for (const d of days.slice(-SCAN_FALLBACK_FLOW_DAYS)) {
        try { const c = await fetchClientTypeForDay(code, d.key); if (c) flows[d.key] = c; } catch {}
      }
    }
    for (const d of flowTargets) {
      const c = flows[d.key];
      if (!c) continue;
      const f = S.dayFlow(c, d.close);
      if (f) Object.assign(d, f);
    }
    hist[code] = { dateKey: today, at: Date.now(), days };
  }

  async function ensureHistory(force=false){
    if (busy) return;
    await loadStore();
    const today = todayKey();
    const rows = (state.rows || []).filter(r => r.hasClient && num(r.valueB) >= S.MIN_VALUE_B)
      .sort((a,b)=>num(b.valueB)-num(a.valueB)).slice(0, SCAN_MAX_SYMBOLS);
    const todo = rows.filter(r => { const h = hist[keyOf(r)]; return force || !h || h.dateKey !== today; });
    if (!todo.length) return;
    busy = true; progress = { done: 0, total: todo.length };
    let idx = 0;
    async function worker(){
      while (idx < todo.length) {
        const r = todo[idx++];
        try { await loadSymbol(r, today); } catch {}
        progress.done++;
        if (progress.done % 10 === 0) renderScan();
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(SCAN_WORKERS, todo.length) }, worker));
      for (const k of Object.keys(hist)) if (hist[k]?.dateKey !== today) delete hist[k];
      await saveStore();
    } finally { busy = false; renderScan(); }
  }

  const f1 = v => v === null || v === undefined ? '—' : pct(v);
  const x1 = v => v === null || v === undefined ? '—' : `${nf(v)}×`;

  function row(x, i, dir){
    const s = dir > 0 ? x.inScore : x.outScore;
    const why = dir > 0 ? x.inReasons : x.outReasons;
    const rs = x.rs === null ? '—' : fa(Math.round(x.rs * 100));
    const trend = x.ma20 ? (x.price >= x.ma20 ? '↗ بالای MA20' : '↘ زیر MA20') : '—';
    return `<tr>
      <td>${fa(i+1)}</td>
      <td><b>${symbolLink(x.row)}</b><br><small>${esc(x.row.assetGroup||'')}</small></td>
      <td><b class="scanScore">${nf(s.total)}</b><br><small>جریان ${fa(Math.round(s.flow*100))} | فعالیت ${fa(Math.round(s.activity*100))} | روند ${fa(Math.round(s.trend*100))}</small></td>
      <td class="${cls(x.bigB)}"><b>${moneyUnit(x.bigB)}</b><br><small>${f1(x.bigPct)} از ارزش | خرید ${moneyUnit(x.bigBuyB)} / فروش ${moneyUnit(x.bigSellB)}</small></td>
      <td><small>سرانه خرید ${moneyUnit(x.buyAvgOrderB)}<br>سرانه فروش ${moneyUnit(x.sellAvgOrderB)}<br>قدرت ${nf(x.buyPower)}×</small></td>
      <td class="${cls(x.big5B)}">${x.big5Pct === null ? '—' : moneyUnit(x.big5B)}<br><small>${f1(x.big5Pct)} | ${x.streak ? fa(x.streak)+' روز پیاپی' : ''}</small></td>
      <td>${x.bigZ === null ? '—' : nf(x.bigZ)}</td>
      <td class="${cls(x.realB)}">${moneyUnit(x.realB)}<br><small>${f1(x.realPct)}</small></td>
      <td>${x1(x.valueRatio)}<br><small>${moneyUnit(x.valueB)}</small></td>
      <td>${rs}<br><small>${trend} | ۲۰روز ${f1(x.ret20)}</small></td>
      <td><small>${why.length ? why.map(esc).join('<br>') : '—'}</small></td>
    </tr>`;
  }

  function renderScan(){
    const page = document.getElementById('scan');
    if (!page) return;
    const res = S.scan(state.rows || [], Object.fromEntries(Object.entries(hist).map(([k,v]) => [k, v.days])), { hms: nowHms(), keyOf, limit: 10 });
    const g = res.regime;
    const status = busy ? `در حال بارگذاری تاریخچه: ${fa(progress.done)} از ${fa(progress.total)}` :
      `تاریخچه قیمت: ${fa(g.withHistory)} نماد | تاریخچه جریان پول: ${fa(g.withFlowHistory)} نماد`;
    const regimeEl = document.getElementById('scanRegime');
    if (regimeEl) regimeEl.innerHTML = `
      <div class="card"><small>وضعیت بازار</small><b class="${g.score>=0.25?'pos':g.score<=-0.25?'neg':''}">${g.label}</b></div>
      <div class="card"><small>مثبت / منفی</small><b>${fa(g.advancers)} / ${fa(g.decliners)}</b></div>
      <div class="card"><small>بالای میانگین ۲۰ روزه</small><b>${g.aboveMa20Pct===null?'—':pct(g.aboveMa20Pct).replace('+','')}</b></div>
      <div class="card"><small>حقیقی / ارزش کل</small><b class="${cls(g.realPct)}">${pct(g.realPct)}</b></div>
      <div class="card"><small>درشت / ارزش کل</small><b class="${cls(g.bigPct)}">${pct(g.bigPct)}</b></div>
      <div class="card"><small>ورود / خروج درشت</small><b>${fa(g.bigInCount)} / ${fa(g.bigOutCount)}</b></div>`;
    const st = document.getElementById('scanStatus'); if (st) st.textContent = status;
    const empty = cols => `<tr><td colspan="${cols}" class="empty">داده کافی نیست؛ پایش را شروع کن.</td></tr>`;
    const inEl = document.getElementById('scanInRows'); if (inEl) inEl.innerHTML = res.inflow.length ? res.inflow.map((x,i)=>row(x,i,1)).join('') : empty(11);
    const outEl = document.getElementById('scanOutRows'); if (outEl) outEl.innerHTML = res.outflow.length ? res.outflow.map((x,i)=>row(x,i,-1)).join('') : empty(11);
    if (!busy && (state.rows||[]).some(r=>r.hasClient)) setTimeout(() => ensureHistory(false), 300);
  }

  document.getElementById('scanReloadBtn')?.addEventListener('click', () => ensureHistory(true));
  if (typeof renderAll === 'function') {
    const prev = renderAll;
    renderAll = function(){ prev(); try { renderScan(); } catch (e) { state.debug?.push?.({ stage:'smart-scan-error', message:e.message||String(e) }); } };
  }
  globalThis.renderSmartScan = renderScan;
})();
