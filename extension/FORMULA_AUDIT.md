# Formula & session audit — v7.1

## Corrected defects

1. **Double/misplaced rial→toman correction**: previous code multiplied estimated big money by `0.1` inside the formula and then converted billion-rial to toman again in the renderer. v7 keeps a single internal unit (billion rial) and converts only at render time.
2. **Historical value fields ignored**: TSETMC history exposes `buy_I_Value` and `sell_I_Value`; v7 uses them directly when present.
3. **Historical count aliases incomplete**: `buy_I_Count` / `sell_I_Count` are now recognized alongside `buy_CountI` / `sell_CountI`.
4. **Live money valued at closing price**: live fallback now uses session VWAP (`qTotCap / qTotTran5J`) before close/last price.
5. **False instant flow from price drift**: instant flow is computed from cumulative client-volume deltas, not from subtracting two cumulative money estimates whose valuation price may have changed.
6. **Unbounded/opaque big-money weight**: replaced by a bounded large-order share in `[0,1]`; estimated side big money cannot exceed total individual side value.
7. **Partial MA labeled as MA5/MA20**: MA5/MA20 now require full 5/20-point windows.
8. **3/5-day completeness**: 3-day and 5-day results require 3/5 distinct valid trading dates.

## Formula definitions

Let internal money unit be billion rial.

- `VWAP = TradeValueRial / TradeVolume` when both are positive.
- `RealBuy = BuyIVolume × VWAP` (live fallback) or `buy_I_Value` (history when available).
- `RealSell = SellIVolume × VWAP` (live fallback) or `sell_I_Value` (history when available).
- `NetReal = RealBuy - RealSell`.
- `AvgBuyOrder = RealBuy / BuyICount`.
- `AvgSellOrder = RealSell / SellICount`.
- `BuyerPower = AvgBuyOrder / AvgSellOrder`; seller power is the reciprocal for positive sides.

### Estimated large money

TSETMC aggregate client-type data does not identify which individual trades are "large". v7 therefore labels this metric as an **estimate**.

For average order `a` (billion rial):

- zero share at/below `0.5` B rial (50M toman),
- smooth transition using `smoothstep` between `0.5` and `6.0` B rial,
- a small bounded power tilt (`0.85..1.15`),
- final share clamped to `[0,1]`.

Then:

- `EstimatedBigBuy = RealBuy × LargeBuyShare`
- `EstimatedBigSell = RealSell × LargeSellShare`
- `EstimatedBigNet = EstimatedBigBuy - EstimatedBigSell`

This is intentionally transparent and bounded; it is not claimed to reproduce a proprietary third-party formula.


## v7.1 session/data-integrity fixes

1. **Pre-open stale ClientType**: old TSETMC bulk endpoints may still expose the previous session's cumulative values. v7.1 does not poll or compute live flow before 09:00 Tehran.
2. **Cross-session contamination**: state is rolled on the Tehran calendar date and old alerts/snapshots/live rows are cleared.
3. **Freshness gate**: `dEven` is checked when supplied; otherwise `hEven` must be plausible for the current session.
4. **ClientType schema ambiguity**: JSON named fields are preferred. Legacy CSV uses the documented `count,count,volume,volume` column order with no guessing.
5. **Snapshot reconciliation**: client buy/sell total volume must be within 15% of the market-watch cumulative volume before money-flow metrics are accepted.
6. **Wrong fund universe**: `دارا`, `آفاق`, and `صایند` are fixed-income funds and are explicitly excluded from the equity/stock universe.
7. **Counter hours**: instant counters/alerts are restricted to the ordinary 09:00–12:30 stock session.
