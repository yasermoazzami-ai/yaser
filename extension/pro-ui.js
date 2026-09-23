/* TSETMC Stocks Radar Pro UI bridge.
   Uses the audited v7.3 market/session/formula engine and renders a lighter product dashboard.
   "پول درشت" remains an analytical estimate because aggregated ClientType does not label individual large trades.
*/
(() => {
  const PRO_MONTHLY_CACHE_MS = 12 * 60 * 60 * 1000;
  const PRO_MONTHLY_SCAN = 36;
  const PRO_ALERT_MAX = 120;
  const PRO_ALERT_COOLDOWN_MS = 60 * 1000;
  const PRO_SYMBOL_COOLDOWN_MS = 20 * 1000;
  const PRO_WATCH_MIN_SCORE = 58;
  const PRO_WATCH_MAX = 12;
  const PRO_CROSS_COOLDOWN_MS = 120 * 1000;
  const PRO_CROSS_CONFIRM_SAMPLES = 3;
  const PRO_CROSS_CONFIRM_MS = 4000;
  const PRO_TREND_CONFIRM_SAMPLES = 5;
  const PRO_TREND_CONFIRM_MS = 10000;
  const PRO_TREND_COOLDOWN_MS = 120 * 1000;
  const PRO_ACTIVITY_HISTORY_MAX = 180;
  const PRO_ACTIVITY_STALE_MS = 30000;
  const PRO_MIN_INTERVAL_VALUE_B = 2; // ۲۰۰ میلیون تومان؛ فقط برای تشخیص اینکه واقعاً معامله‌ای رخ داده است
  const PRO_VALUE_WINDOW_MS = 30 * 1000;
  const PRO_VALUE_SPIKE_ABS_B = 50; // ۵ میلیارد تومان در پنجره ۳۰ ثانیه‌ای
  const PRO_VALUE_SPIKE_SMALL_B = 20; // استثنای نماد کوچک: ۲ میلیارد تومان + سهم بسیار بالا از ارزش روز
  const PRO_VALUE_SPIKE_DAILY_SHARE = 0.08;
  const PRO_VALUE_SPIKE_RATIO = 3.0;
  const PRO_VALUE_SPIKE_SCORE = 0.80; // ارزش ۶۰٪، حجم ۲۵٪، تعداد معاملات ۱۵٪

  function safeNum(v){ const n=Number(v); return Number.isFinite(n)?n:0; }
  function proMoney(b){ return moneyUnit(safeNum(b)); }
  function proTone(v){ return safeNum(v)>0?'proPos':safeNum(v)<0?'proNeg':''; }
  function proTime(ts){ try{return new Date(ts).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}catch{return '—';} }
  function symbolKey(r){ return String(r?.numericInsCode || r?.insCode || r?.instrumentID || r?.symbol || ''); }

  function ensureShell(){
    if(document.getElementById('proDashboard')) return;
    const radar=document.getElementById('radar');
    if(!radar) return;
    const anchor=document.getElementById('unitGuide');
    const el=document.createElement('div');
    el.id='proDashboard'; el.className='proDashboard';
    el.innerHTML=`
      <section id="proKpis" class="proKpis"></section>
      <section class="proGrid3">
        <div class="proPanel"><div class="proPanelHead"><h3>رادار نمادهای منتخب</h3><span class="proHint">پول حقیقی، پول درشت، قدرت خرید و روند</span></div><div class="proScroll"><table class="proTable proRadarTable"><thead><tr><th>نماد</th><th>قیمت</th><th>تغییر</th><th>حقیقی</th><th>درشت</th><th>قدرت</th><th>روند ح</th><th>روند د</th><th>روند ق</th></tr></thead><tbody id="proRadarRows"></tbody></table></div></div>
        <div class="proPanel"><div class="proPanelHead"><h3>دیدبان سریع</h3><span class="proHint">فقط سیگنال‌های چندتأییدی با امتیاز بالا</span></div><div id="proWatch" class="proScroll"></div></div>
        <div class="proPanel"><div class="proPanelHead"><h3>هشدارهای مهم</h3><span class="proHint">فقط هشدارهای قوی و تأییدشده</span></div><div id="proAlerts" class="proScroll"></div></div>
      </section>
      <section class="proSignalsGrid">
        <div class="proSignalPanel">
          <div class="proPanelHead"><h3>تغییر روند پول درشت</h3><span class="proHint">تأیید ۵ نمونه، حداقل ۱۰ ثانیه و فعالیت واقعی</span></div>
          <div class="proSignalScroll"><table class="proTable proTrendChangeTable"><thead><tr><th>زمان</th><th>نماد</th><th>تغییر</th><th>پول درشت</th><th>قدرت</th></tr></thead><tbody id="proBigTrendChanges"></tbody></table></div>
        </div>
        <div class="proSignalPanel">
          <div class="proPanelHead"><h3>کراس‌های مهم</h3><span class="proHint">کراس تأییدشده با فعالیت واقعی؛ قدرت ۱.۵/۰.۷ و قیمت ±۰.۷٪</span></div>
          <div class="proSignalScroll"><table class="proTable proCrossTable"><thead><tr><th>زمان</th><th>نماد</th><th>نوع</th><th>جهت</th><th>قبل</th><th>بعد</th></tr></thead><tbody id="proCrossRows"></tbody></table></div>
        </div>
      </section>
      <section class="proLowerSection">
        <div class="proLowerHeader">
          <div class="proLowerTabs"><button type="button" class="proLowerTab" data-mode="groups">گروه‌ها</button><button type="button" class="proLowerTab" data-mode="symbols">نمادها</button><button type="button" class="proLowerTab active" data-mode="pulse">پالس پول</button></div>
          <span class="proHint">پالس پول در یک جدول خوانا؛ مبلغ، سهم از ارزش معاملات و امتیاز شدت</span>
        </div>
        <div id="proPulseTabs" class="proPulseTabs">
          <button type="button" class="proPulseTab active" data-pulse="bigIn">ورود درشت</button>
          <button type="button" class="proPulseTab" data-pulse="bigOut">خروج درشت</button>
          <button type="button" class="proPulseTab" data-pulse="realIn">ورود حقیقی</button>
          <button type="button" class="proPulseTab" data-pulse="realOut">خروج حقیقی</button>
        </div>
        <section id="proLower" class="proLowerGrid proPulseMode"></section>
      </section>
      <div class="proFootnote">محاسبات پول حقیقی و پول درشت از مسیر محاسباتی 8.13.3 استفاده می‌کنند. پالس پول فقط یک نمای رتبه‌بندی است و هیچ عدد پایه‌ای را تغییر نمی‌دهد.</div>`;
    if(anchor) anchor.insertAdjacentElement('afterend',el); else radar.prepend(el);
    el.querySelectorAll('.proLowerTab').forEach(btn=>btn.addEventListener('click',()=>{
      state.proLowerMode=['groups','symbols','pulse'].includes(btn.dataset.mode)?btn.dataset.mode:'pulse';
      el.querySelectorAll('.proLowerTab').forEach(x=>x.classList.toggle('active',x===btn));
      renderLower(marketRows());
    }));
    el.querySelectorAll('.proPulseTab').forEach(btn=>btn.addEventListener('click',()=>{
      state.proPulseMode=['bigIn','bigOut','realIn','realOut'].includes(btn.dataset.pulse)?btn.dataset.pulse:'bigIn';
      el.querySelectorAll('.proPulseTab').forEach(x=>x.classList.toggle('active',x===btn));
      renderLower(marketRows());
    }));
  }

  function marketRows(){ return typeof v662MarketRows==='function' ? v662MarketRows(state.rows||[]) : (state.rows||[]); }
  function groupAgg(rows){
    const m=new Map();
    for(const r of rows){
      const g=r.assetGroup||'سایر/نامشخص';
      const x=m.get(g)||{name:g,real:0,big:0,value:0,count:0};
      x.real+=safeNum(r.realMoneyB); x.big+=safeNum(r.bigMoneyB); x.value+=safeNum(r.valueB); x.count++; m.set(g,x);
    }
    return [...m.values()];
  }
  function weightedPower(rows){
    let sw=0,sv=0;
    for(const r of rows){ const p=safeNum(r.buyPower); if(p<=0) continue; const w=Math.max(.001,safeNum(r.individualBuyB)+safeNum(r.individualSellB),safeNum(r.valueB)); sw+=p*w; sv+=w; }
    return sv?sw/sv:0;
  }
  function weightedMarketTrend(rows){ return weightedAvg(rows,x=>x.lastPercent,x=>Math.max(.001,x.valueB||x.volume||1)); }

  function trendDir(r,key,kind){
    try{ const h=bigTrendForRow(r); const info=v720MetricInfo(h,key,kind); return info.points>=2?info.direction:0; }catch{return 0;}
  }
  function trendText(r){
    const rd=trendDir(r,'r','money'), bd=trendDir(r,'b','money'), pd=trendDir(r,'p','power');
    const a=d=>d>0?'↗':d<0?'↘':'→'; return `ح ${a(rd)} | د ${a(bd)} | ق ${a(pd)}`;
  }

  function volumeAvgInfo(r){
    const c=state.proVolumeAvg?.[symbolKey(r)];
    if(!c || !c.avg || (Date.now()-safeNum(c.at))>PRO_MONTHLY_CACHE_MS*2) return null;
    return c;
  }
  function volumeRatio(r){ const c=volumeAvgInfo(r); return c?.avg>0?safeNum(r.volume)/c.avg:0; }
  function likelyCurrentBuyQueue(r){
    const lp=safeNum(r.lastPrice), max=safeNum(r.priceMax), pctv=safeNum(r.lastPercent);
    return (max>0 && lp>=max && pctv>1.5) || pctv>=4.85;
  }

  function likelyCurrentSellQueue(r){
    const lp=safeNum(r.lastPrice), min=safeNum(r.priceMin), pctv=safeNum(r.lastPercent);
    return (min>0 && lp<=min && pctv<-1.5) || pctv<=-4.85;
  }
  function activityKey(r){ return symbolKey(r); }
  function medianFinite(values){
    const a=(values||[]).map(Number).filter(Number.isFinite).sort((x,y)=>x-y);
    if(!a.length) return 0; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2;
  }
  function observeActivity(p,r,now=Date.now()){
    state.proActivity=state.proActivity&&typeof state.proActivity==='object'?state.proActivity:{};
    const key=activityKey(r); if(!key) return null;
    const dVal=Math.max(0,safeNum(r.valueB)-safeNum(p?.valueB));
    const dVol=Math.max(0,safeNum(r.volume)-safeNum(p?.volume));
    const dTrades=Math.max(0,safeNum(r.tradeCount)-safeNum(p?.tradeCount));
    const active=dVal>0 || dVol>0 || dTrades>0;
    const prevState=state.proActivity[key]&&typeof state.proActivity[key]==='object'?state.proActivity[key]:{samples:[],lastActiveAt:0};
    const gapMs=prevState.lastActiveAt?now-safeNum(prevState.lastActiveAt):0;
    let history=(Array.isArray(prevState.samples)?prevState.samples:[]).filter(x=>x&&now-safeNum(x.t)<=6*60*1000).slice(-PRO_ACTIVITY_HISTORY_MAX);
    const sample={t:now,dVal,dVol,dTrades};
    if(active) history.push(sample);
    history=history.slice(-PRO_ACTIVITY_HISTORY_MAX);

    // پنجره ۳۰ ثانیه‌ای جاری: به‌جای اینکه یک تیک ۲ ثانیه‌ای را «جهش» بنامیم، فعالیت واقعی ۳۰ ثانیه را جمع می‌کنیم.
    const current=history.filter(x=>now-safeNum(x.t)<PRO_VALUE_WINDOW_MS);
    const windowVal=sum(current,x=>safeNum(x.dVal));
    const windowVol=sum(current,x=>safeNum(x.dVol));
    const windowTrades=sum(current,x=>safeNum(x.dTrades));

    // پنج پنجره ۳۰ ثانیه‌ای قبلی، بدون هم‌پوشانی با پنجره جاری، baseline همان نماد را می‌سازند.
    const prevWindows=[];
    for(let i=1;i<=5;i++){
      const hi=now-i*PRO_VALUE_WINDOW_MS;
      const lo=hi-PRO_VALUE_WINDOW_MS;
      const bucket=history.filter(x=>safeNum(x.t)>=lo&&safeNum(x.t)<hi);
      const bVal=sum(bucket,x=>safeNum(x.dVal));
      const bVol=sum(bucket,x=>safeNum(x.dVol));
      const bTrades=sum(bucket,x=>safeNum(x.dTrades));
      if(bVal>0||bVol>0||bTrades>0) prevWindows.push({dVal:bVal,dVol:bVol,dTrades:bTrades});
    }
    const medVal=medianFinite(prevWindows.map(x=>x.dVal).filter(x=>x>0));
    const medVol=medianFinite(prevWindows.map(x=>x.dVol).filter(x=>x>0));
    const medTrades=medianFinite(prevWindows.map(x=>x.dTrades).filter(x=>x>0));
    const enoughBaseline=prevWindows.length>=3;
    const queued=likelyCurrentBuyQueue(r)||likelyCurrentSellQueue(r);
    const dailyValue=Math.max(0,safeNum(r.valueB));
    const dailyShare=dailyValue>0?windowVal/dailyValue:0;

    // meaningful برای کراس/روند فقط می‌گوید معامله تازه و قابل اعتنا رخ داده؛ خودش هشدار جهش نیست.
    let meaningful=active && dVal>=PRO_MIN_INTERVAL_VALUE_B && (dTrades>=2 || dVal>=15);
    if(gapMs>PRO_ACTIVITY_STALE_MS) meaningful=active && dVal>=10 && (dTrades>=5 || dVal>=30);
    if(queued) meaningful=active && dVal>=10 && (dTrades>=5 || dVal>=30);

    let valueSpike=false,valueSpikeScore=0,valueRatio=0,volumeConfirmRatio=0,tradeConfirmRatio=0;
    if(enoughBaseline && windowVal>0){
      const valBase=Math.max(5,medVal||0); // ۵۰۰ میلیون تومان baseline حداقلی
      const volBase=Math.max(1,medVol||0);
      const tradeBase=Math.max(1,medTrades||0);
      valueRatio=windowVal/valBase;
      volumeConfirmRatio=windowVol/volBase;
      tradeConfirmRatio=windowTrades/tradeBase;
      const valuePart=Math.min(1,valueRatio/PRO_VALUE_SPIKE_RATIO);
      const volumePart=Math.min(1,volumeConfirmRatio/2.5);
      const tradePart=Math.min(1,tradeConfirmRatio/2.5);
      valueSpikeScore=.60*valuePart+.25*volumePart+.15*tradePart;

      const absoluteStrong=windowVal>=PRO_VALUE_SPIKE_ABS_B && windowTrades>=8;
      const smallButMaterial=windowVal>=PRO_VALUE_SPIKE_SMALL_B && dailyShare>=PRO_VALUE_SPIKE_DAILY_SHARE && windowTrades>=5;
      valueSpike=(absoluteStrong||smallButMaterial) && valueRatio>=PRO_VALUE_SPIKE_RATIO && valueSpikeScore>=PRO_VALUE_SPIKE_SCORE;

      // بعد از سکون طولانی یا در صف، فقط جهش واقعاً بزرگ مجاز است؛ یک معامله منفرد هرگز کافی نیست.
      if(gapMs>PRO_ACTIVITY_STALE_MS || queued){
        valueSpike=valueSpike && windowVal>=PRO_VALUE_SPIKE_ABS_B && windowTrades>=10;
      }
    }

    state.proActivity[key]={
      samples:history,
      lastActiveAt:active?now:prevState.lastActiveAt||0,
      last:{t:now,dVal,dVol,dTrades,windowVal,windowVol,windowTrades,dailyShare,meaningful,valueSpike,valueSpikeScore,valueRatio,volumeConfirmRatio,tradeConfirmRatio,gapMs,queued,medVal,medVol,medTrades,enoughBaseline}
    };
    return state.proActivity[key].last;
  }
  function latestActivity(rOrKey){
    const key=typeof rOrKey==='string'?rOrKey:activityKey(rOrKey);
    return state.proActivity&&state.proActivity[key]?.last || null;
  }
  function rawCandidateScore(r){
    if(!r?.liveSessionData || !r?.hasClient || likelyCurrentBuyQueue(r)) return -1;
    let s=0;
    const bp=safeNum(r.buyPower), real=safeNum(r.realMoneyB), big=safeNum(r.bigMoneyB), vr=volumeRatio(r), gap=safeNum(r.gap), pctv=safeNum(r.lastPercent);
    s += Math.min(25, Math.max(0,(bp-0.8)*14));
    s += Math.min(20, Math.max(0,real/8));
    s += Math.min(20, Math.max(0,big/5));
    s += Math.min(15, Math.max(0,(vr-1)*10));
    s += Math.min(8, Math.max(0,gap*4));
    s += pctv>0 ? Math.min(7,pctv*2) : 0;
    const t=[trendDir(r,'r','money'),trendDir(r,'b','money'),trendDir(r,'p','power')];
    s += t.filter(x=>x>0).length*2 - t.filter(x=>x<0).length*2;
    return Math.max(0,Math.min(100,s));
  }
  function candidateScore(r){ return Math.round(rawCandidateScore(r)*10)/10; }
  function reasons(r){
    const out=[]; const vr=volumeRatio(r);
    if(safeNum(r.buyPower)>=1.8) out.push(`قدرت ${nf(r.buyPower)}×`);
    if(safeNum(r.realMoneyB)>20) out.push('ورود حقیقی');
    if(safeNum(r.bigMoneyB)>12) out.push('ورود درشت');
    if(vr>=2) out.push(`حجم ${nf(vr)}×`);
    if(safeNum(r.gap)>0.3) out.push('آخرین قوی‌تر');
    if(trendDir(r,'r','money')>0 || trendDir(r,'b','money')>0) out.push('روند مثبت');
    return out.slice(0,3).join(' / ') || 'نیازمند بررسی بیشتر';
  }

  function appendMarketHistory(rows){
    const session=globalThis.RadarMarketSession?.current?.();
    if(!session || !globalThis.RadarMarketSession?.canGenerateAlerts?.(session)) return;
    if(!rows.some(r=>r?.liveSessionData)) return;
    const now=Date.now();
    state.proMarketHistory=Array.isArray(state.proMarketHistory)?state.proMarketHistory.filter(x=>x && x.d===session.dateKey):[];
    const last=state.proMarketHistory[state.proMarketHistory.length-1];
    if(last && now-safeNum(last.t)<15000) return;
    const real=sum(rows,x=>safeNum(x.realMoneyB));
    const big=sum(rows,x=>safeNum(x.bigMoneyB));
    const power=weightedPower(rows);
    const trend=weightedMarketTrend(rows);
    const positive=rows.filter(x=>safeNum(x.lastPercent)>0).length;
    state.proMarketHistory.push({t:now,d:session.dateKey,real,big,power,trend,positive});
    state.proMarketHistory=state.proMarketHistory.slice(-180);
  }
  function sparkFromHistory(key,color='#16a34a'){
    const vals=(state.proMarketHistory||[]).map(x=>safeNum(x?.[key])).filter(Number.isFinite).slice(-40);
    if(vals.length<2) return `<div class="proSpark"><svg viewBox="0 0 100 28" preserveAspectRatio="none"><polyline points="0,18 30,18 65,18 100,18" fill="none" stroke="${color}" stroke-width="1.6" stroke-dasharray="4 3" opacity=".55"/></svg></div>`;
    let min=Math.min(...vals),max=Math.max(...vals); if(min===max){min-=1;max+=1;}
    const pts=vals.map((v,i)=>`${(i*100/Math.max(1,vals.length-1)).toFixed(1)},${(25-((v-min)/(max-min))*22).toFixed(1)}`).join(' ');
    return `<div class="proSpark"><svg viewBox="0 0 100 28" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
  }
  function renderKpis(rows){
    const real=sum(rows,x=>safeNum(x.realMoneyB)); const big=sum(rows,x=>safeNum(x.bigMoneyB)); const power=weightedPower(rows); const trend=weightedMarketTrend(rows); const positives=rows.filter(x=>safeNum(x.lastPercent)>0).length;
    const cards=[
      ['روند بازار',`${trend>0?'+':''}${nf(trend)}٪`,`${fa(positives)} نماد مثبت`,trend,'#7c3aed'],
      ['قدرت خرید حقیقی',power?`${nf(power)}×`:'—','میانگین وزنی قدرت خرید',power-1,'#2563eb'],
      ['برآیند پول درشت',proMoney(big),'برآورد تحلیلی، نه فیلد رسمی',big,big>=0?'#16a34a':'#dc2626'],
      ['برآیند پول حقیقی',proMoney(real),'خالص ارزش خرید و فروش حقیقی',real,real>=0?'#16a34a':'#dc2626'],
      ['تعداد نمادهای مثبت',fa(positives),`از ${fa(rows.length)} نماد`,positives-(rows.length/2),'#16a34a']
    ];
    const keys=['trend','power','big','real','positive'];
    $('proKpis').innerHTML=cards.map((c,i)=>`<div class="proKpi"><div class="proKpiHead"><span>${c[0]}</span><span>${c[3]>=0?'↗':'↘'}</span></div><div class="proKpiValue ${c[3]>0?'proPos':c[3]<0?'proNeg':''}">${c[1]}</div><div class="proKpiSub">${c[2]}</div>${sparkFromHistory(keys[i],c[4])}</div>`).join('');
  }

  function trendArrow(r,key,kind){
    const d=trendDir(r,key,kind);
    return `<span class="proTrend ${d>0?'up':d<0?'down':'flat'}">${d>0?'↗':d<0?'↘':'→'}</span>`;
  }
  function renderRadar(rows){
    const scored=rows.map(r=>({r,s:candidateScore(r)})).sort((a,b)=>Math.max(Math.abs(safeNum(b.r.realMoneyB)),Math.abs(safeNum(b.r.bigMoneyB)),b.s)-Math.max(Math.abs(safeNum(a.r.realMoneyB)),Math.abs(safeNum(a.r.bigMoneyB)),a.s)).slice(0,28);
    $('proRadarRows').innerHTML=scored.length?scored.map(({r})=>`<tr>
      <td><b>${symbolLink(r)}</b><div class="proSubline">${esc(r.assetGroup||'')}</div></td>
      <td>${nf(safeNum(r.lastPrice||r.finalPrice||r.pClosing||0))}</td>
      <td class="${proTone(r.lastPercent)}">${safeNum(r.lastPercent)>0?'+':''}${nf(r.lastPercent)}٪</td>
      <td class="${proTone(r.realMoneyB)}">${proMoney(r.realMoneyB)}</td>
      <td class="${proTone(r.bigMoneyB)}">${proMoney(r.bigMoneyB)}</td>
      <td>${safeNum(r.buyPower)>0?`${nf(r.buyPower)}×`:'—'}</td>
      <td>${trendArrow(r,'r','money')}</td><td>${trendArrow(r,'b','money')}</td><td>${trendArrow(r,'p','power')}</td>
    </tr>`).join(''):'<tr><td colspan="9">داده زنده هنوز آماده نیست.</td></tr>';
  }
  function watchConfirmations(r){
    const out=[]; const vr=volumeRatio(r);
    if(safeNum(r.buyPower)>=1.5) out.push('قدرت');
    if(safeNum(r.realMoneyB)>=20) out.push('حقیقی');
    if(safeNum(r.bigMoneyB)>=12) out.push('درشت');
    if(vr>=1.8) out.push('حجم');
    if(safeNum(r.gap)>=.45) out.push('قیمت');
    if(trendDir(r,'r','money')>0) out.push('روند حقیقی');
    if(trendDir(r,'b','money')>0) out.push('روند درشت');
    return out;
  }
  function renderWatch(rows){
    const list=rows.map(r=>({r,s:candidateScore(r),c:watchConfirmations(r)}))
      .filter(x=>x.s>=PRO_WATCH_MIN_SCORE && x.c.length>=2)
      .sort((a,b)=>b.s-a.s).slice(0,PRO_WATCH_MAX);
    $('proWatch').innerHTML=list.length?`<table class="proTable proWatchTable"><thead><tr><th>نماد</th><th>امتیاز</th><th>قدرت</th><th>تأییدها</th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${symbolLink(x.r)}</b><div class="proSubline ${proTone(x.r.bigMoneyB)}">درشت: ${proMoney(x.r.bigMoneyB)}</div></td><td class="proScore">${nf(x.s/10)}/10</td><td>${safeNum(x.r.buyPower)>0?`${nf(x.r.buyPower)}×`:'—'}</td><td class="proWatchReasons">${esc(x.c.slice(0,3).join(' + '))}</td></tr>`).join('')}</tbody></table>`:'<div class="proEmptyState">فعلاً سیگنال چندتأییدی قوی وجود ندارد.</div>';
  }

  function pushProAlert(a){
    state.proAlerts=Array.isArray(state.proAlerts)?state.proAlerts:[];
    state.proAlertCooldown=state.proAlertCooldown&&typeof state.proAlertCooldown==='object'?state.proAlertCooldown:{};
    state.proSymbolAlertCooldown=state.proSymbolAlertCooldown&&typeof state.proSymbolAlertCooldown==='object'?state.proSymbolAlertCooldown:{};
    const now=safeNum(a.time)||Date.now();
    const typeKey=`${a.type}:${a.key}`;
    if(now-safeNum(state.proAlertCooldown[typeKey])<PRO_ALERT_COOLDOWN_MS) return;
    if(now-safeNum(state.proSymbolAlertCooldown[a.key])<PRO_SYMBOL_COOLDOWN_MS && a.force!==true) return;
    state.proAlertCooldown[typeKey]=now;
    state.proSymbolAlertCooldown[a.key]=now;
    const k=`${a.type}:${a.key}:${Math.floor(now/PRO_ALERT_COOLDOWN_MS)}`;
    state.proAlerts.unshift({...a,time:now,id:k,severity:a.severity||'strong'});
    state.proAlerts=state.proAlerts.slice(0,PRO_ALERT_MAX);
  }
  function detectProAlerts(prevRows,newRows){
    const pm=new Map((prevRows||[]).map(x=>[symbolKey(x),x]));
    const now=Date.now();
    for(const r of newRows||[]){
      if(!r?.liveSessionData || !r?.hasClient) continue;
      const key=symbolKey(r),p=pm.get(key); if(!p) continue;
      const act=observeActivity(p,r,now); if(!act) continue;
      if(act.valueSpike){
        const queueNote=act.queued?' | صف/لب‌صف: شرط سخت‌تر اعمال شد':'';
        const shareText=act.dailyShare>0?`${nf(act.dailyShare*100)}٪ از ارزش امروز نماد`:'—';
        pushProAlert({time:now,key,symbol:r.symbol,type:'valueSpike',detail:`۳۰ثانیه: ${proMoney(act.windowVal)} | ${nf(act.valueRatio)}× baseline | ${fa(Math.round(act.windowTrades))} معامله | ${shareText}${queueNote}`,tone:'warn',severity:'strong'});
      }
      // قدرت، کراس و تغییر روند در پنل‌های تخصصی خودشان نمایش داده می‌شوند تا «هشدارهای مهم» تکراری و گیج‌کننده نشود.
    }
  }

  function crossDirection(value, eps=0){
    const n=safeNum(value);
    return n>eps?1:n<-eps?-1:0;
  }
  function pushCross(item){
    state.proCrosses=Array.isArray(state.proCrosses)?state.proCrosses:[];
    state.proCrossCooldown=state.proCrossCooldown&&typeof state.proCrossCooldown==='object'?state.proCrossCooldown:{};
    const now=safeNum(item.time)||Date.now();
    const cooldownKey=`${item.type}:${item.key}`;
    if(now-safeNum(state.proCrossCooldown[cooldownKey])<PRO_CROSS_COOLDOWN_MS) return;
    state.proCrossCooldown[cooldownKey]=now;
    const id=`${item.type}:${item.key}:${item.from}:${item.to}:${Math.floor(now/PRO_CROSS_COOLDOWN_MS)}`;
    state.proCrosses.unshift({...item,time:now,id,severity:'strong'});
    state.proCrosses=state.proCrosses.slice(0,80);
    const tone=item.to>0?'buy':'sell';
  }
  function zoneByThreshold(value,positive,negative){
    const n=safeNum(value); return n>=positive?1:n<=negative?-1:0;
  }
  function detectCrosses(prevRows,newRows){
    const session=globalThis.RadarMarketSession?.current?.();
    if(!session || !globalThis.RadarMarketSession?.canGenerateAlerts?.(session)) return;
    const day=String(session.dateKey||'');
    if(state.proCrossDay!==day){ state.proCrossDay=day; state.proCrosses=[]; state.proCrossState={}; state.proCrossCooldown={}; state.proCrossCandidates={}; }
    state.proCrossState=state.proCrossState&&typeof state.proCrossState==='object'?state.proCrossState:{};
    state.proCrossCandidates=state.proCrossCandidates&&typeof state.proCrossCandidates==='object'?state.proCrossCandidates:{};
    const now=Date.now();
    for(const r of newRows||[]){
      if(!r?.liveSessionData || !r?.hasClient) continue;
      const key=symbolKey(r); if(!key) continue;
      const act=latestActivity(key);
      const defs=[
        {type:'real',value:safeNum(r.realMoneyB),zone:zoneByThreshold(r.realMoneyB,20,-20),minMove:15,alertUp:'realCrossIn',alertDown:'realCrossOut',fmt:v=>proMoney(v),detail:z=>`پول حقیقی وارد ناحیه ${z>0?'ورود قوی':'خروج قوی'} شد`},
        {type:'big',value:safeNum(r.bigMoneyB),zone:zoneByThreshold(r.bigMoneyB,15,-15),minMove:10,alertUp:'bigCrossIn',alertDown:'bigCrossOut',fmt:v=>proMoney(v),detail:z=>`پول درشت وارد ناحیه ${z>0?'ورود قوی':'خروج قوی'} شد`},
        {type:'power',value:safeNum(r.buyPower),zone:zoneByThreshold(r.buyPower,1.50,.70),minMove:.18,alertUp:'powerCrossUp',alertDown:'powerCrossDown',fmt:v=>`${nf(v)}×`,detail:z=>`قدرت خریدار وارد ناحیه ${z>0?'قوی بالای ۱.۵':'ضعیف زیر ۰.۷'} شد`},
        {type:'price',value:safeNum(r.gap),zone:zoneByThreshold(r.gap,.70,-.70),minMove:.35,alertUp:'priceCrossUp',alertDown:'priceCrossDown',fmt:v=>`${nf(v)}٪`,detail:z=>`اختلاف آخرین/پایانی وارد ناحیه ${z>0?'مثبت بالای ۰.۷٪':'منفی زیر ۰.۷٪'} شد`}
      ];
      for(const d of defs){
        const sk=`${key}:${d.type}`; const confirmed=state.proCrossState[sk];
        if(!confirmed){ if(d.zone) state.proCrossState[sk]={zone:d.zone,value:d.value,t:now}; continue; }
        if(!d.zone || d.zone===confirmed.zone){ delete state.proCrossCandidates[sk]; if(d.zone) state.proCrossState[sk]={...confirmed,value:d.value}; continue; }
        // Never confirm a cross merely because the same stale snapshot is polled repeatedly.
        if(!act?.meaningful) { delete state.proCrossCandidates[sk]; continue; }
        if(Math.abs(d.value-safeNum(confirmed.value))<d.minMove) { delete state.proCrossCandidates[sk]; continue; }
        let cand=state.proCrossCandidates[sk];
        if(!cand || cand.zone!==d.zone) cand={zone:d.zone,count:1,firstAt:now,lastActiveT:act.t};
        else if(cand.lastActiveT!==act.t){ cand.count++; cand.lastActiveT=act.t; }
        state.proCrossCandidates[sk]=cand;
        if(cand.count<PRO_CROSS_CONFIRM_SAMPLES || now-cand.firstAt<PRO_CROSS_CONFIRM_MS) continue;
        pushCross({time:now,key,symbol:r.symbol,type:d.type,alertType:d.zone>0?d.alertUp:d.alertDown,from:confirmed.zone,to:d.zone,before:d.fmt(confirmed.value),after:d.fmt(d.value),detail:`${d.detail(d.zone)} | ${d.fmt(confirmed.value)} ← ${d.fmt(d.value)}`});
        state.proCrossState[sk]={zone:d.zone,value:d.value,t:now}; delete state.proCrossCandidates[sk];
      }
    }
  }

  const crossTypeLabel={real:'پول حقیقی',big:'پول درشت',power:'قدرت خریدار',price:'آخرین / پایانی'};
  function renderCrosses(){
    const box=$('proCrossRows'); if(!box) return;
    const list=(state.proCrosses||[]).filter(x=>(x.severity||'strong')==='strong').slice(0,6);
    box.innerHTML=list.length?list.map(a=>`<tr>
      <td>${proTime(a.time)}</td><td><b>${esc(a.symbol||'—')}</b></td><td>${esc(crossTypeLabel[a.type]||a.type)}</td>
      <td><span class="proBadge ${a.to>0?'buy':'sell'}">${a.to>0?'مثبت ↗':'منفی ↘'}</span></td><td>${esc(a.before||'—')}</td><td class="${a.to>0?'proPos':'proNeg'}">${esc(a.after||'—')}</td>
    </tr>`).join(''):'<tr><td colspan="6" class="proEmptyLight">فعلاً کراس معنی‌دار ثبت نشده است.</td></tr>';
  }


  function bigTrendWord(d){ return d>0?'صعودی':d<0?'نزولی':'خنثی'; }
  function median(values){ const a=(values||[]).filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return 0; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
  function significantBigTrend(r,d){
    try{
      const h=(bigTrendForRow(r)||[]).filter(x=>x&&Number.isFinite(Number(x.b))).slice(-24);
      if(h.length<6) return false;
      const span=safeNum(h[h.length-1]?.t)-safeNum(h[0]?.t); if(span<15000) return false;
      const diffs=[]; const signed=[];
      for(let i=1;i<h.length;i++){ const dv=safeNum(h[i].b)-safeNum(h[i-1].b); diffs.push(Math.abs(dv)); signed.push(Math.sign(dv)); }
      const info=v720MetricInfo(h,'b','money');
      const floor=Math.max(15,median(diffs)*3.5,Math.abs(safeNum(info.current))*.05,(safeNum(info.max)-safeNum(info.min))*.20);
      const recentSigns=signed.slice(-5).filter(x=>x!==0); const agreeing=recentSigns.filter(x=>x===d).length;
      const stable=recentSigns.length>=3 && agreeing/recentSigns.length>=.75;
      return d!==0 && stable && Math.abs(safeNum(info.recentDelta))>=floor;
    }catch{return false;}
  }
  function detectBigTrendChanges(rows){
    const session=globalThis.RadarMarketSession?.current?.();
    if(!session || !globalThis.RadarMarketSession?.canGenerateAlerts?.(session)) return;
    const day=String(session.dateKey||'');
    if(state.proBigTrendDay!==day){ state.proBigTrendDay=day; state.proBigTrendLast={}; state.proBigTrendCandidates={}; state.proBigTrendChanges=[]; state.proBigTrendCooldown={}; }
    state.proBigTrendLast=state.proBigTrendLast&&typeof state.proBigTrendLast==='object'?state.proBigTrendLast:{};
    state.proBigTrendCandidates=state.proBigTrendCandidates&&typeof state.proBigTrendCandidates==='object'?state.proBigTrendCandidates:{};
    state.proBigTrendCooldown=state.proBigTrendCooldown&&typeof state.proBigTrendCooldown==='object'?state.proBigTrendCooldown:{};
    state.proBigTrendChanges=Array.isArray(state.proBigTrendChanges)?state.proBigTrendChanges:[];
    const now=Date.now();
    for(const r of rows||[]){
      if(!r?.liveSessionData || !r?.hasClient) continue;
      const key=symbolKey(r); if(!key) continue;
      const act=latestActivity(key);
      if(!act?.meaningful || now-safeNum(act.t)>15000){ delete state.proBigTrendCandidates[key]; continue; }
      const d=trendDir(r,'b','money');
      if(!d || !significantBigTrend(r,d)){ delete state.proBigTrendCandidates[key]; continue; }
      const confirmed=state.proBigTrendLast[key];
      if(!confirmed){ state.proBigTrendLast[key]={d,t:now}; delete state.proBigTrendCandidates[key]; continue; }
      if(confirmed.d===d){ delete state.proBigTrendCandidates[key]; continue; }
      let cand=state.proBigTrendCandidates[key];
      if(!cand || cand.d!==d) cand={d,count:1,firstAt:now}; else cand.count++;
      state.proBigTrendCandidates[key]=cand;
      if(cand.count<PRO_TREND_CONFIRM_SAMPLES || now-cand.firstAt<PRO_TREND_CONFIRM_MS) continue;
      if(now-safeNum(state.proBigTrendCooldown[key])<PRO_TREND_COOLDOWN_MS) continue;
      const item={id:`${day}:${key}:${confirmed.d}:${d}:${Math.floor(now/PRO_TREND_COOLDOWN_MS)}`,time:now,key,symbol:r.symbol,from:confirmed.d,to:d,big:safeNum(r.bigMoneyB),power:safeNum(r.buyPower),severity:'strong'};
      state.proBigTrendChanges.unshift(item); state.proBigTrendChanges=state.proBigTrendChanges.slice(0,30);
      state.proBigTrendLast[key]={d,t:now}; state.proBigTrendCooldown[key]=now; delete state.proBigTrendCandidates[key];
    }
  }
  function renderBigTrendChanges(){
    const box=$('proBigTrendChanges'); if(!box) return;
    const list=(state.proBigTrendChanges||[]).filter(x=>(x.severity||'strong')==='strong').slice(0,6);
    box.innerHTML=list.length?list.map(a=>`<tr><td>${proTime(a.time)}</td><td><b>${esc(a.symbol||'—')}</b></td><td><span class="proBadge ${a.to>0?'buy':'sell'}">${bigTrendWord(a.from)} ← ${bigTrendWord(a.to)}</span></td><td class="${proTone(a.big)}">${proMoney(a.big)}</td><td>${a.power>0?`${nf(a.power)}×`:'—'}</td></tr>`).join(''):'<tr><td colspan="5" class="proEmptyLight">فعلاً تغییر روند تأییدشده‌ای وجود ندارد.</td></tr>';
  }

  const proTypeLabel={valueSpike:'جهش ارزش معاملات',volume:'افزایش ناگهانی حجم',power:'افزایش قدرت خرید',realIn:'ورود ناگهانی پول حقیقی',realOut:'خروج ناگهانی پول حقیقی',bigIn:'ورود ناگهانی پول درشت',bigOut:'خروج ناگهانی پول درشت',bigTrendUp:'تغییر روند پول درشت به صعودی',bigTrendDown:'تغییر روند پول درشت به نزولی',realCrossIn:'کراس حقیقی: خروج ← ورود',realCrossOut:'کراس حقیقی: ورود ← خروج',bigCrossIn:'کراس درشت: خروج ← ورود',bigCrossOut:'کراس درشت: ورود ← خروج',powerCrossUp:'قدرت خریدار وارد ناحیه قوی',powerCrossDown:'قدرت خریدار وارد ناحیه ضعیف',priceCrossUp:'آخرین حداقل ۰.۵٪ بالای پایانی',priceCrossDown:'آخرین حداقل ۰.۵٪ زیر پایانی'};
  function renderProAlerts(){
    const list=(state.proAlerts||[]).filter(a=>(a.severity||'strong')==='strong').slice(0,10);
    $('proAlerts').innerHTML=list.length?`<div class="proAlertCompactList">${list.map(a=>`<div class="proAlertCompactItem"><div class="proAlertCompactHead"><span class="proAlertCompactTime">${proTime(a.time)}</span><b class="proAlertCompactSymbol">${esc(a.symbol||'—')}</b><span class="proBadge ${a.tone||'watch'}">${esc(proTypeLabel[a.type]||a.type)}</span></div><div class="proAlertCompactDetail">${esc(a.detail||'')}</div></div>`).join('')}</div>`:'<div class="proEmptyState">فعلاً هشدار قوی جدیدی وجود ندارد.</div>';
  }


  function pulseRatioPct(r,key){
    const value=Math.max(0,safeNum(r?.valueB));
    return value>0?safeNum(r?.[key])/value*100:0;
  }
  function pulseImpact(r,key,dir){
    const flow=safeNum(r?.[key]);
    if((dir>0&&flow<=0)||(dir<0&&flow>=0)) return null;
    const value=Math.max(0,safeNum(r?.valueB));
    if(value<10 || Math.abs(flow)<2) return null;
    const ratio=Math.abs(flow)/value*100;
    const ratioPart=Math.min(1,ratio/12);
    const cache=volumeAvgInfo(r);
    const avgValue=Math.max(0,safeNum(cache?.avgValueB));
    const normalPart=avgValue>0?Math.min(1,(Math.abs(flow)/avgValue)/0.10):Math.min(1,Math.abs(flow)/80);
    const trendKey=key==='realMoneyB'?'r':'b';
    const td=trendDir(r,trendKey,'money');
    const persistence=td===dir?1:td===0?.45:0;
    let score=10*(.55*ratioPart+.30*normalPart+.15*persistence);
    if(value<20) score*=.85;
    return {r,key,dir,flow,value,ratio,avgValue,score:Math.round(score*10)/10,persistence};
  }
  function pulseStrength(score){ return score>=8.5?'خیلی قوی':score>=7?'قوی':score>=5.5?'متوسط':'در حال شکل‌گیری'; }
  function pulseItems(rows,key,dir,limit=15){
    return (rows||[]).map(r=>pulseImpact(r,key,dir)).filter(Boolean).sort((a,b)=>b.score-a.score || Math.abs(b.flow)-Math.abs(a.flow)).slice(0,limit);
  }
  function pulseConfig(mode){
    return mode==='bigOut'?{key:'bigMoneyPulseB',dir:-1,title:'خروج پول درشت ۶۰ ثانیه اخیر',tone:'sell'}:
      mode==='realIn'?{key:'realMoneyB',dir:1,title:'ورود پول حقیقی امروز',tone:'buy'}:
      mode==='realOut'?{key:'realMoneyB',dir:-1,title:'خروج پول حقیقی امروز',tone:'sell'}:
      {key:'bigMoneyPulseB',dir:1,title:'ورود پول درشت ۶۰ ثانیه اخیر',tone:'buy'};
  }
  function renderPulseBoard(rows){
    const mode=['bigIn','bigOut','realIn','realOut'].includes(state.proPulseMode)?state.proPulseMode:'bigIn';
    state.proPulseMode=mode;
    document.querySelectorAll('.proPulseTab').forEach(btn=>btn.classList.toggle('active',btn.dataset.pulse===mode));
    const cfg=pulseConfig(mode), items=pulseItems(rows,cfg.key,cfg.dir,15);
    if(!items.length) return `<div class="proPulseBoard"><div class="proPulseBoardTitle"><b>${cfg.title}</b><span>فعلاً جریان معناداری برای رتبه‌بندی وجود ندارد.</span></div><div class="proEmptyState">داده کافی نیست.</div></div>`;
    return `<div class="proPulseBoard">
      <div class="proPulseBoardTitle"><b>${cfg.title}</b><span>۱۵ نماد برتر بر اساس مبلغ + سهم جریان از ارزش معاملات + پایداری</span></div>
      <div class="proPulseTableHead"><span>رتبه</span><span>نماد</span><span>مبلغ جریان</span><span>سهم از ارزش معاملات</span><span>امتیاز</span><span>وضعیت</span></div>
      <div class="proPulseRows">${items.map((x,i)=>`<div class="proPulseRow">
        <span class="proPulseRank">${fa(i+1)}</span>
        <b class="proPulseSymbol">${symbolLink(x.r)}</b>
        <strong class="${x.dir>0?'proPos':'proNeg'}">${proMoney(x.flow)}</strong>
        <span class="proPulseRatio">${nf(x.ratio)}٪</span>
        <span class="proPulseScore">${nf(x.score)}/10</span>
        <span class="proPulseStrength ${x.score>=7?'strong':x.score>=5.5?'medium':'forming'}">${pulseStrength(x.score)}</span>
      </div>`).join('')}</div>
    </div>`;
  }

  function listCard(title,subtitle,items,tone='blue',extra=''){
    return `<div class="proListCard"><h4 class="${tone==='green'?'proPos':tone==='red'?'proNeg':''}">${title}</h4><div class="subtitle">${subtitle||''}</div><div class="proMiniScroll">${items.length?items.map((x,i)=>`<div class="proRankRow"><span class="proRank">${fa(i+1)}</span><div><b>${x.link?symbolLink(x.link):esc(x.name)}</b>${x.sub?`<div class="proSubline">${esc(x.sub)}</div>`:''}</div><span class="${x.valueClass||''}">${x.value}</span></div>`).join(''):'<div class="proHint" style="padding:10px">داده کافی نیست.</div>'}</div>${extra}</div>`;
  }
  function renderLower(rows){
    const groups=groupAgg(rows);
    const topG=(key,dir)=>[...groups].filter(x=>dir>0?x[key]>0:x[key]<0).sort((a,b)=>dir>0?b[key]-a[key]:a[key]-b[key]).slice(0,15).map(x=>({name:x.name,value:proMoney(x[key]),valueClass:dir>0?'proPos':'proNeg'}));
    const topS=(key,dir)=>[...rows].filter(x=>dir>0?safeNum(x[key])>0:safeNum(x[key])<0).sort((a,b)=>dir>0?safeNum(b[key])-safeNum(a[key]):safeNum(a[key])-safeNum(b[key])).slice(0,15).map(r=>({name:r.symbol,link:r,value:proMoney(r[key]),valueClass:dir>0?'proPos':'proNeg'}));
    const mode=['groups','symbols','pulse'].includes(state.proLowerMode)?state.proLowerMode:'pulse';
    state.proLowerMode=mode;
    const lower=$('proLower'), pulseTabs=$('proPulseTabs');
    document.querySelectorAll('.proLowerTab').forEach(btn=>btn.classList.toggle('active',btn.dataset.mode===mode));
    if(mode==='pulse'){
      if(pulseTabs) pulseTabs.hidden=false;
      lower.classList.add('proPulseMode');
      lower.innerHTML=renderPulseBoard(rows);
    }else{
      if(pulseTabs) pulseTabs.hidden=true;
      lower.classList.remove('proPulseMode');
      const cards=mode==='symbols' ? [
        listCard('بیشترین خروج پول حقیقی از نمادها','خالص امروز',topS('realMoneyB',-1),'red'),
        listCard('بیشترین ورود پول حقیقی به نمادها','خالص امروز',topS('realMoneyB',1),'green'),
        listCard('بیشترین خروج پول درشت از نمادها','برآورد امروز',topS('bigMoneyB',-1),'red'),
        listCard('بیشترین ورود پول درشت به نمادها','برآورد امروز',topS('bigMoneyB',1),'green')
      ] : [
        listCard('بیشترین خروج پول حقیقی از گروه‌ها','خالص امروز',topG('real',-1),'red'),
        listCard('بیشترین ورود پول حقیقی به گروه‌ها','خالص امروز',topG('real',1),'green'),
        listCard('بیشترین خروج پول درشت از گروه‌ها','برآورد امروز',topG('big',-1),'red'),
        listCard('بیشترین ورود پول درشت به گروه‌ها','برآورد امروز',topG('big',1),'green')
      ];
      lower.innerHTML=cards.join('');
    }

    const suspicious=[...rows].map(r=>({r,ratio:volumeRatio(r)})).filter(x=>x.ratio>=2).sort((a,b)=>b.ratio-a.ratio).slice(0,15).map(x=>({name:x.r.symbol,link:x.r,value:`${nf(x.ratio)}×`,valueClass:'proWarn',sub:`حجم ${nf(x.r.volume)} | میانگین ${nf(volumeAvgInfo(x.r)?.avg||0)}`}));
    const sideSuspicious=$('proSideSuspicious');
    if(sideSuspicious) sideSuspicious.innerHTML=suspicious.length?suspicious.slice(0,10).map((x,i)=>`<div class="proSideRow"><span>${fa(i+1)}</span><b>${x.link?symbolLink(x.link):esc(x.name)}</b><em class="proWarn">${x.value}</em></div>`).join(''):'<div class="proSideEmpty">داده کافی نیست.</div>';
  }

  async function fetchAvgVolume20(r){
    const code=String(r.numericInsCode||r.insCode||'').trim(); if(!/^\d{8,}$/.test(code)) return null;
    const text=await fetchSilent(`https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/${encodeURIComponent(code)}/0`,10000);
    const json=JSON.parse(text); const arr=extractDailyArrays(json)[0]||[];
    const last20=arr.slice(-20);
    const vols=last20.map(o=>toNum(val(o,['qTotTran5J','QTotTran5J','volume','Volume','totalVolume','qTotTran5JIns']))).filter(x=>x>0);
    const vals=last20.map(o=>toNum(val(o,['qTotCap','QTotCap','value','Value','totalValue','tradeValue']))/1e9).filter(x=>x>0);
    if(vols.length<5) return null;
    return {avg:vols.reduce((a,b)=>a+b,0)/vols.length,avgValueB:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0,days:vols.length,at:Date.now()};
  }
  let proVolumeBusy=false;
  async function ensureVolumeAverages(){
    if(proVolumeBusy) return;
    const sess=globalThis.RadarMarketSession?.current?.();
    const rows=marketRows().filter(r=>r.numericInsCode||r.insCode);
    if(!rows.length) return;
    state.proVolumeAvg=state.proVolumeAvg&&typeof state.proVolumeAvg==='object'?state.proVolumeAvg:{};
    const candidates=[...rows].sort((a,b)=>{
      const ar=safeNum(a.baseVolume)>0?safeNum(a.volume)/safeNum(a.baseVolume):safeNum(a.volume);
      const br=safeNum(b.baseVolume)>0?safeNum(b.volume)/safeNum(b.baseVolume):safeNum(b.volume);
      return br-ar;
    }).slice(0,PRO_MONTHLY_SCAN).filter(r=>{const c=state.proVolumeAvg[symbolKey(r)];return !c || Date.now()-safeNum(c.at)>PRO_MONTHLY_CACHE_MS;});
    if(!candidates.length) return;
    proVolumeBusy=true;
    let idx=0;
    async function worker(){ while(idx<candidates.length){ const r=candidates[idx++]; try{ const c=await fetchAvgVolume20(r); if(c) state.proVolumeAvg[symbolKey(r)]=c; }catch{} } }
    try{ await Promise.all(Array.from({length:Math.min(4,candidates.length)},worker)); await saveCache(); renderProUI(); }finally{proVolumeBusy=false;}
  }

  function renderProUI(){
    ensureShell(); const rows=marketRows();
    if(!state.proLowerMode) state.proLowerMode='pulse';
    if(!state.proPulseMode) state.proPulseMode='bigIn';
    appendMarketHistory(rows);
    detectBigTrendChanges(rows);
    renderKpis(rows); renderRadar(rows); renderWatch(rows); renderProAlerts(); renderBigTrendChanges(); renderCrosses(); renderLower(rows);
    if(rows.length) setTimeout(ensureVolumeAverages,200);
  }

  // Add pro alerts to each valid refresh without altering legacy alert policy.
  if(typeof detectInstantAlerts==='function'){
    const legacyDetect=detectInstantAlerts;
    detectInstantAlerts=function(prevRows,newRows){
      const base=legacyDetect(prevRows,newRows);
      try{ detectProAlerts(prevRows,newRows); }catch(e){ state.debug?.push?.({stage:'pro-alert-error',message:e.message||String(e)}); }
      try{ detectCrosses(prevRows,newRows); }catch(e){ state.debug?.push?.({stage:'pro-cross-error',message:e.message||String(e)}); }
      return base;
    };
  }
  if(typeof renderAll==='function'){
    const legacyRenderAll=renderAll;
    renderAll=function(){ legacyRenderAll(); try{renderProUI();}catch(e){state.debug?.push?.({stage:'pro-render-error',message:e.message||String(e)});} };
  }

  window.addEventListener('DOMContentLoaded',()=>{
    ensureShell();
    const settings=document.getElementById('proSettingsBtn');
    const controls=document.querySelector('.engineControls');
    if(settings&&controls) settings.addEventListener('click',()=>controls.classList.toggle('open'));
    const theme=document.getElementById('proThemeBtn');
    if(theme) theme.addEventListener('click',()=>document.body.classList.toggle('proDark'));
    const notify=document.getElementById('proNotifyBtn');
    if(notify) notify.addEventListener('click',()=>{ const t=document.querySelector('.tab[data-page="alerts"]'); if(t) t.click(); });
    setTimeout(renderProUI,50);
  });
})();


/* v8.2 viewport reset: Chrome can restore scrollTop for nested scrolling containers on reload.
   Always open the dashboard from the very first KPI row, exactly like the approved mockup. */
(() => {
  function resetApprovedViewport(){
    try { history.scrollRestoration = 'manual'; } catch {}
    const main = document.querySelector('main');
    const side = document.querySelector('.proSidebar');
    if(main) main.scrollTop = 0;
    if(side) side.scrollTop = 0;
    try { window.scrollTo(0,0); } catch {}
  }
  window.addEventListener('DOMContentLoaded', () => {
    requestAnimationFrame(() => requestAnimationFrame(resetApprovedViewport));
    const dash = document.querySelector('.tab[data-page="radar"]');
    if(dash) dash.addEventListener('click', () => requestAnimationFrame(resetApprovedViewport));
  });
  window.addEventListener('load', () => setTimeout(resetApprovedViewport, 0), {once:true});
})();
