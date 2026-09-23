(function attachMarketSession(root, factory) {
  const api = factory();
  root.RadarMarketSession = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMarketSession() {
  'use strict';

  const TZ = 'Asia/Tehran';
  const MAIN_OPEN = 90000;
  const MAIN_CLOSE = 123000;
  const TAL_OPEN = 124500;
  const TAL_CLOSE = 130000;
  const CLOCK_SKEW_SEC = 120;

  function int(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }

  function parts(date = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    });
    const out = {};
    for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
    const y = int(out.year), m = int(out.month), d = int(out.day);
    const hh = int(out.hour), mm = int(out.minute), ss = int(out.second);
    return {
      dateKey: `${String(y).padStart(4,'0')}${String(m).padStart(2,'0')}${String(d).padStart(2,'0')}`,
      weekday: out.weekday || '',
      hour: hh, minute: mm, second: ss,
      hms: hh * 10000 + mm * 100 + ss,
      seconds: hh * 3600 + mm * 60 + ss
    };
  }

  function hmsToSeconds(hms) {
    const x = int(hms);
    const hh = Math.floor(x / 10000);
    const mm = Math.floor((x % 10000) / 100);
    const ss = x % 100;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return -1;
    return hh * 3600 + mm * 60 + ss;
  }

  function isRegularTradeDay(weekday) {
    return ['Sat','Sun','Mon','Tue','Wed'].includes(String(weekday || ''));
  }

  function current(date = new Date()) {
    const p = parts(date);
    let phase = 'closed-day';
    if (isRegularTradeDay(p.weekday)) {
      if (p.hms < MAIN_OPEN) phase = 'pre-open';
      else if (p.hms < MAIN_CLOSE) phase = 'main';
      else if (p.hms < TAL_OPEN) phase = 'mid-break';
      else if (p.hms < TAL_CLOSE) phase = 'tal';
      else phase = 'after-close';
    }
    return { ...p, phase, isTradeDay:isRegularTradeDay(p.weekday) };
  }

  function canGenerateAlerts(session) {
    // Time-of-day gate removed: on regular trading days the radar may refresh,
    // calculate and record signals before 09:00 and after 12:30 as well.
    return Boolean(session?.isTradeDay) && session?.phase !== 'closed-day';
  }

  function shouldZeroLiveMetrics(session) {
    // Keep only the non-trading-day guard; do not zero metrics by clock time.
    return session?.phase === 'closed-day';
  }

  function extractHEven(row) {
    return int(row?.hEven ?? row?.heven ?? row?.HEven ?? row?.lastHEven ?? 0);
  }

  function extractDEven(row) {
    return String(row?.dEven ?? row?.deven ?? row?.DEven ?? row?.finalLastDate ?? '').replace(/\D/g,'').slice(0,8);
  }

  function rowFreshForCurrentSession(row, session, sessionTradingObserved=false) {
    if (!row || !session || !session.isTradeDay || session.phase === 'closed-day') return false;

    const dEven = extractDEven(row);
    if (dEven.length === 8) return dEven === session.dateKey;

    const hEven = extractHEven(row);
    if (hEven <= 0) return false;
    const hs = hmsToSeconds(hEven);
    if (hs < 0) return false;

    // Time-of-day restriction removed. When the feed has no date field, accept a
    // timestamp that is not in the future relative to Tehran time. This keeps the
    // stale/future-row guard without forcing the 09:00–12:30 window.
    return hs <= session.seconds + CLOCK_SKEW_SEC;
  }

  function assessMarket(rows, session) {
    const list = Array.isArray(rows) ? rows : [];
    let exactDate = 0, plausibleTime = 0;
    for (const r of list) {
      const d = extractDEven(r);
      if (d.length === 8 && d === session?.dateKey) exactDate++;
      if (rowFreshForCurrentSession(r, session, false)) plausibleTime++;
    }
    const minEvidence = Math.min(10, Math.max(2, Math.floor(list.length * 0.01)));
    const observed = exactDate >= minEvidence || plausibleTime >= minEvidence;
    return { observed, exactDate, plausibleTime, total:list.length };
  }

  function phaseLabel(phase) {
    return ({
      'pre-open':'پیش از شروع بازار',
      'main':'بازار باز',
      'mid-break':'پایان جلسه اصلی',
      'tal':'معاملات پایانی',
      'after-close':'بازار بسته',
      'closed-day':'روز غیرمعاملاتی'
    })[phase] || 'وضعیت نامشخص';
  }

  return {
    TZ, MAIN_OPEN, MAIN_CLOSE, TAL_OPEN, TAL_CLOSE,
    parts, current, canGenerateAlerts, shouldZeroLiveMetrics,
    extractHEven, extractDEven, rowFreshForCurrentSession, assessMarket, phaseLabel
  };
});
