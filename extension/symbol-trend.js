(function attachSymbolTrend(root, factory) {
  const api = factory();
  root.RadarSymbolTrend = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSymbolTrend() {
  'use strict';

  function finite(v, fallback=0){
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function compact(arr, max=180){
    const src = (Array.isArray(arr) ? arr : []).filter(Boolean).sort((a,b)=>finite(a.t)-finite(b.t));
    if(src.length <= max) return src;
    const first = src[0], last = src[src.length-1];
    const body = src.slice(1,-1);
    const keep = Math.max(1, max-2);
    const step = Math.max(1, Math.ceil(body.length/keep));
    const out = [first];
    for(let i=0; i<body.length && out.length<max-1; i+=step) out.push(body[i]);
    if(out[out.length-1] !== last) out.push(last);
    return out.slice(0,max);
  }

  function changedEnough(a,b){
    if(!a) return true;
    const metrics = ['b','r','p','s'];
    return metrics.some(k => Math.abs(finite(a[k])-finite(b[k])) > (k==='p' || k==='s' ? 0.001 : 0.0001));
  }

  function strongMove(a,b){
    if(!a) return true;
    const bBig = Math.abs(finite(b.b)-finite(a.b)) > Math.max(1, Math.abs(finite(a.b)||finite(b.b))*0.03);
    const rBig = Math.abs(finite(b.r)-finite(a.r)) > Math.max(1, Math.abs(finite(a.r)||finite(b.r))*0.03);
    const pBig = Math.abs(finite(b.p)-finite(a.p)) > Math.max(0.08, Math.abs(finite(a.p)||finite(b.p))*0.06);
    return bBig || rBig || pBig;
  }

  function append(arr, point, opts={}){
    const minGapMs = Math.max(5000, finite(opts.minGapMs,15000));
    const max = Math.max(30, finite(opts.max,180));
    let out = (Array.isArray(arr) ? arr : []).filter(p=>p && (!point.d || p.d===point.d));
    const last = out[out.length-1];
    if(!last){ out.push({...point}); return compact(out,max); }
    const enoughTime = finite(point.t)-finite(last.t) >= minGapMs;
    if(changedEnough(last,point) && (enoughTime || strongMove(last,point))) out.push({...point});
    else {
      // Update the value inside the current sampling bucket but preserve its original timestamp;
      // otherwise 1-second polling would keep resetting the clock and a trend might never get a second point.
      const bucketT = last.t, bucketD = last.d;
      Object.assign(last, point);
      last.t = bucketT; last.d = bucketD;
    }
    return compact(out,max);
  }

  function metricInfo(hist,key,kind='money'){
    const src = (Array.isArray(hist) ? hist : []).filter(p=>p && Number.isFinite(Number(p[key]))).sort((a,b)=>finite(a.t)-finite(b.t));
    if(!src.length) return {points:0,current:0,fullDelta:0,recentDelta:0,direction:0,label:'بدون داده'};
    const vals = src.map(p=>finite(p[key]));
    const current = vals[vals.length-1];
    if(vals.length<2) return {points:1,current,fullDelta:0,recentDelta:0,direction:0,label:'در حال شکل‌گیری'};
    const first = vals[0];
    const idx = Math.max(0, vals.length-1-Math.max(2,Math.floor(vals.length*0.2)));
    const recentStart = vals[idx];
    const fullDelta = current-first;
    const recentDelta = current-recentStart;
    const range = Math.max(...vals)-Math.min(...vals);
    const threshold = kind==='power'
      ? Math.max(0.04, Math.abs(current)*0.025, range*0.08)
      : Math.max(0.5, Math.abs(current)*0.015, range*0.05);
    const direction = recentDelta>threshold ? 1 : recentDelta<-threshold ? -1 : 0;
    let label = direction>0 ? 'در حال تقویت' : direction<0 ? 'در حال تضعیف' : 'تقریباً ثابت';
    if(kind==='power'){
      const state = current>=1.2 ? 'قدرت خریدار بالا' : current<=0.8 ? 'قدرت خریدار پایین' : 'قدرت متعادل';
      label = `${state}؛ ${label}`;
    }else{
      const state = current>0 ? 'خالص ورود' : current<0 ? 'خالص خروج' : 'خالص صفر';
      label = `${state}؛ ${label}`;
    }
    return {points:vals.length,current,first,fullDelta,recentDelta,direction,label,min:Math.min(...vals),max:Math.max(...vals)};
  }

  return { finite, compact, append, metricInfo };
});
