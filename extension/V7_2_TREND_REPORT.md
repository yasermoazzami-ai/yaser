# v7.2 — Per-symbol flow & buyer-power trends

## Added
- Intraday trend for **real individual money** (`realMoneyB`) for every valid symbol.
- Intraday trend for **estimated big money** (`bigMoneyB`) for every valid symbol.
- Intraday trend for **buyer power** (`buyPower`) for every valid symbol.
- A combined trend cell in both **Symbols** and **Big Money** tables.
- Each metric shows current value, recent direction (↗/↘/→), recent delta, and a sparkline.

## Session/data guard
Trend points are recorded only when:
- Tehran market session is the main 09:00–12:30 session.
- The row is fresh for the current session (`liveSessionData`).
- ClientType passed validation (`hasClient`).

So pre-open/stale data cannot create a symbol trend.

## Sampling
- Baseline is the first valid point.
- Normal sampling interval is roughly 10–45 seconds depending on the monitor interval.
- Strong moves can create a point sooner.
- Up to 180 compacted points are kept per symbol for the current Tehran trading date.
- Sampling-bucket timestamps are preserved so 1-second polling cannot indefinitely postpone the next trend point.

## Tests
31/31 Node tests pass, including session guards, formula engine, and symbol-trend behavior.
