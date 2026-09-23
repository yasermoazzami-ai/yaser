# v7.1 Bugfix report — screenshot at 08:35 Tehran

## Root causes

### 1. Previous-day cumulative data was treated as today
The extension started its one-second monitor immediately on page load. Before the market opens, TSETMC legacy bulk endpoints can still return cumulative fields from the last trading session. Those values were rendered as if they belonged to the current day.

**Fix:** hard session gate using `Asia/Tehran`; before 09:00 no live money calculation or alert generation occurs. A fresh storage namespace and per-Tehran-date reset prevent cached/snapshot carry-over.

### 2. Fixed-income ETFs were incorrectly in the equity radar
The screenshot contains `دارا`, `آفاق`, and `صایند`. These are fixed-income funds, not equity funds. Their large turnover distorted the “real money outflow” ranking.

**Fix:** removed them from the equity allowlist and added them to the fixed-income denylist. The denylist is evaluated before the equity-fund allowlist.

### 3. Legacy ClientTypeAll column order was being guessed
The old CSV has a documented fixed schema. Guessing between layouts can swap participant counts and volumes and create absurd money-flow values.

**Fix:** prefer JSON `GetClientTypeAll`; when CSV fallback is necessary, parse only the documented layout. In addition, client buy/sell total volumes are reconciled against market volume; suspicious rows are not used for money calculations.

### 4. Session freshness was not validated per symbol
A symbol row could contain an old `hEven`/`dEven` and still be accepted.

**Fix:** validate `dEven` against the Tehran date when available; otherwise accept `hEven` only if it is plausible for the current session.

## Verification

`node --test tests/*.test.js`: 27/27 passed.

Specific regression tests cover 08:35 Tehran (pre-open/no alerts), 09:05 Tehran (main session), stale 12:30 `hEven` just after open, date mismatch, Thursday/Friday closure, and stop-after-12:30 behavior.
