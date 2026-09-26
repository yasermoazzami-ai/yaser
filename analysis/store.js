'use strict';

// History store for the scheduled reports.
//   data/base.json.gz          last full export from the extension (price + real/legal
//                              history from TSETMC); replaced whenever a new export arrives
//   data/daily/<date>.json.gz  one compact day captured from the live source
// loadHistory() = base + every daily file newer than the base, in the export format that
// tse-report.js consumes.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const core = require('../extension/export-core');
const { faKey } = require('./live');

const ROOT = path.join(__dirname, '..', 'data');
const BASE = path.join(ROOT, 'base.json.gz');
const DAILY = path.join(ROOT, 'daily');

const readGz = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
const writeGz = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(obj), { level: 9 })); };
const dayNum = iso => Number(String(iso).slice(0, 10).replace(/-/g, ''));

// Keeps only what the report needs from an extension export.
function importBase(exportFile) {
  const src = readGz(exportFile);
  const slim = {
    schema: src.schema, exportedAt: src.exportedAt, options: src.options, index: src.index,
    symbols: src.symbols.filter(s => !s.skipped && s.daily && s.daily.rows && s.daily.rows.length).map(s => ({
      insCode: s.insCode, symbol: s.symbol, name: s.name, info: s.info, daily: { columns: s.daily.columns, rows: s.daily.rows }, client: s.client && { columns: s.client.columns, rows: s.client.rows }
    }))
  };
  writeGz(BASE, slim);
  return slim;
}

// One live session → compact per-symbol day record.
function dayRecord(date, snapshots, details, indices) {
  const symbols = {};
  for (const [key, s] of snapshots) {
    if (!(s.value > 0)) continue;
    const d = details.get(key);
    symbols[key] = d ? {
      open: d.open, high: d.high, low: d.low, close: d.final, last: d.last, yesterday: d.yesterday, vol: d.vol, value: d.value, count: d.count,
      rbv: d.realBuyVol, rsv: d.realSellVol, lbv: d.legalBuyVol, lsv: d.legalSellVol, rbc: d.realBuyCount, rsc: d.realSellCount, lbc: d.legalBuyCount, lsc: d.legalSellCount,
      rbV: d.realBuyVal, rsV: d.realSellVal, lbV: d.legalBuyVal, lsV: d.legalSellVal, eps: d.eps, exact: true
    } : {
      open: s.open, high: s.high, low: s.low, close: s.final, last: s.last, yesterday: s.yesterday,
      vol: s.last > 0 ? Math.round(s.value / s.last) : null, value: s.value, count: null,
      rbv: s.realBuyVol, rsv: s.realSellVol, rbc: s.realBuyCount, rsc: s.realSellCount, rbV: s.realBuyVal, rsV: s.realSellVal
    };
  }
  return { date, index: indices, symbols };
}

function saveDay(rec) {
  const f = path.join(DAILY, `${rec.date}.json.gz`);
  writeGz(f, rec);
  return f;
}

function listDays() {
  if (!fs.existsSync(DAILY)) return [];
  return fs.readdirSync(DAILY).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort();
}

function applyDay(data, rec, maxDays) {
  const d = dayNum(rec.date);
  for (const s of data.symbols) {
    const x = rec.symbols[faKey(s.symbol)];
    if (!x || !(x.close > 0)) continue;
    const rows = s.daily.rows;
    if (rows.length && rows[rows.length - 1][0] >= d) continue;
    rows.push([d, x.open, x.high, x.low, x.close, x.last, x.yesterday, x.vol, x.value, x.count]);
    if (maxDays && rows.length > maxDays) rows.splice(0, rows.length - maxDays);
    if (s.client) {
      const c = s.client.rows;
      if (!c.length || c[c.length - 1][0] < d) {
        c.push([d, x.rbv, x.rsv, x.lbv ?? null, x.lsv ?? null, x.rbc, x.rsc, x.lbc ?? null, x.lsc ?? null, x.rbV, x.rsV, x.lbV ?? null, x.lsV ?? null]);
        if (maxDays && c.length > maxDays) c.splice(0, c.length - maxDays);
      }
    }
    if (x.eps > 0 && s.info) s.info.epsForecast = x.eps;
  }
  const idx = rec.index || {};
  const push = (block, v) => {
    if (!block || !(v > 0)) return;
    const r = block.rows;
    if (!r.length || r[r.length - 1][0] < d) r.push([d, v, null, null]);
  };
  if (data.index) { push(data.index.tedpix, idx.index); push(data.index.equalWeight, idx.equalWeight); }
}

function loadHistory({ before } = {}) {
  if (!fs.existsSync(BASE)) throw new Error(`no base history at ${BASE}; import an extension export first`);
  const data = readGz(BASE);
  const maxDays = (data.options && data.options.days) || 320;
  const baseLast = Math.max(...data.symbols.map(s => s.daily.rows.length ? s.daily.rows[s.daily.rows.length - 1][0] : 0));
  const applied = [];
  for (const f of listDays()) {
    if (before && f.slice(0, 10) >= before) continue; // intraday: compare against the previous session
    const rec = readGz(path.join(DAILY, f));
    if (dayNum(rec.date) <= baseLast) continue;
    applyDay(data, rec, maxDays);
    applied.push(rec.date);
  }
  data.appliedDays = applied;
  data.lastDate = applied.length ? applied[applied.length - 1] : String(baseLast).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  return data;
}

module.exports = { ROOT, BASE, DAILY, readGz, writeGz, dayNum, importBase, dayRecord, saveDay, listDays, applyDay, loadHistory };
