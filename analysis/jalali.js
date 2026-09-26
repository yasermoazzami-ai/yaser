'use strict';

// Gregorian → Jalali (Solar Hijri) conversion for report labels.
function toJalali(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + gdm[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

// '2026-09-23' → { iso: '1405-07-01', label: '۱ مهر ۱۴۰۵' }
function jalali(isoDate) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  const [jy, jm, jd] = toJalali(y, m, d);
  const p = n => String(n).padStart(2, '0');
  return { iso: `${jy}-${p(jm)}-${p(jd)}`, label: `${jd.toLocaleString('fa-IR')} ${MONTHS[jm - 1]} ${String(jy).replace(/\d/g, c => '۰۱۲۳۴۵۶۷۸۹'[c])}` };
}

module.exports = { toJalali, jalali };
