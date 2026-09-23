# Sources used for formula/API audit

- TSETMC Python client field definitions and history endpoint handling:
  https://github.com/5j9/tsetmc/blob/main/tsetmc/instruments.py
- TSETMC market-watch field mapping (`tvol`, `tval`, client-type layout):
  https://github.com/5j9/tsetmc/blob/main/tsetmc/market_watch.py
- TSETMC endpoint/field reference (`qTotTran5J` volume, `qTotCap` value, `I` individual, `N` legal):
  https://github.com/solitraderbusiness/tsetmc-mcp/blob/main/docs/endpoints.md
- Example history schema including `Buy_I_Value` / `Sell_I_Value`:
  https://github.com/mohammad-k13/TESTMC-HISTORY-MCP/blob/main/History_API_Guide.md

The extension does not claim that its estimated large-money metric is an official TSETMC field. The estimate is documented in `FORMULA_AUDIT.md`.

- MarketWatch schema and `heven` as last-transaction time:
  https://github.com/5j9/tsetmc/blob/main/tsetmc/market_watch.py
- Current ordinary stock session (09:00–12:30) checked against exchange-hours reporting.
- Fund classifications cross-checked against fund/market listings for دارا، آفاق، صایند.
