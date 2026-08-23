# iShares

## Using Bun

```bash
bunx degit daggerok/iShares#main ./12345 && cd $_
bunx parcel ./index.html
open http://0:1234
```

## Updating the static iShares data

Run the updater with Bun:

```bash
bun test scripts/update-ishares-data.test.ts
bun scripts/update-ishares-data.ts
```

The **Update iShares ETF data** GitHub Actions workflow exposes the same settings as manual inputs. All supplied filters use **AND** logic.

### Update controls

| Environment variable | Default | Meaning |
|---|---:|---|
| `MAX_FETCHES` | all | Maximum eligible fund update attempts. Empty or `0` means all. The legacy `ISHARES_LIMIT` name remains supported. |
| `REQUEST_SLEEP` | `0` | Minimum delay in seconds between outgoing request starts, including retries. Decimal values are accepted. |
| `MIN_AUM` | empty | Inclusive minimum Net Assets in USD. Plain amounts and `K`, `M`, `B`, or `T` suffixes are accepted. |
| `MAX_AUM` | empty | Inclusive maximum Net Assets in USD. |
| `AUM_PRESET` | `all` | One of `nano`, `micro`, `small`, `mid`, `large`, or `all`. Applied in addition to explicit AUM bounds. |
| `CONCURRENCY` | `4` | Number of parallel fund update workers. Request starts are still globally spaced by `REQUEST_SLEEP`. |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated historical NAV JSON page. `HISTORICAL_PAGE_SIZE` remains supported as an alias. |
| `STORE_RAW_DOWNLOADS` | off | Store the latest source XLS under `api/ishares/raw`. Values `1`, `true`, `yes`, `y`, and `on` enable it. The legacy `ISHARES_STORE_RAW_DOWNLOADS` name remains supported. |
| `MAX_RETRIES` | `2` | Retries after the initial request. The default permits at most three attempts total. Only network errors, HTTP 408/425/429, and 5xx responses are retried with bounded exponential backoff. |
| `TICKERS` | all | Space-, comma-, or semicolon-separated ticker allowlist, for example `IVV DGRO DVY`. |
| `MIN_DIVIDEND_YIELD` | empty | Inclusive minimum 12-month trailing dividend yield percentage. |
| `MAX_DIVIDEND_YIELD` | empty | Inclusive maximum 12-month trailing dividend yield percentage. |

AUM presets use these ranges:

```text
nano:     AUM < $10M
micro:    $10M <= AUM < $300M
small:    $300M <= AUM < $2B
mid:      $2B <= AUM < $10B
large:    AUM >= $10B
all:      no named AUM restriction
```

Example:

```bash
TICKERS="IVV DGRO DVY" \
MAX_RETRIES=2 \
REQUEST_SLEEP=0.5 \
MIN_AUM=300M \
MAX_DIVIDEND_YIELD=4 \
CONCURRENCY=3 \
bun scripts/update-ishares-data.ts
```

`TICKERS` combines with AUM, yield, and return filters using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files.

### Performance and total-return ranges

The following variables accept an inclusive range:

```text
PERFORMANCE_YTD
PERFORMANCE_1Y
PERFORMANCE_3Y
PERFORMANCE_5Y
PERFORMANCE_10Y
TOTAL_RETURN_YTD
TOTAL_RETURN_1Y
TOTAL_RETURN_3Y
TOTAL_RETURN_5Y
TOTAL_RETURN_10Y
```

Range syntax:

| Value | Meaning |
|---|---|
| `5:20` | from 5% through 20%, inclusive |
| `5:` | at least 5% |
| `:20` | at most 20% |
| `5` | at least 5% (short form) |

`PERFORMANCE_1Y`, `PERFORMANCE_3Y`, `PERFORMANCE_5Y`, and `PERFORMANCE_10Y` use average-annual NAV total return. The multi-year values are period-specific **CAGR** values. Therefore a standalone `TOTAL_RETURN_CAGR` would be ambiguous and is intentionally not provided—use the performance variable for the period you mean.

`TOTAL_RETURN_*` uses cumulative NAV total return for the selected period. iShares does not publish an annualized YTD value, so both `PERFORMANCE_YTD` and `TOTAL_RETURN_YTD` use cumulative YTD NAV total return. One-year annualized and one-year cumulative return are likewise mathematically equal.

Metrics are derived from the official workbook's monthly NAV total-return series at its latest available quarter end. Return filters are evaluated after that workbook is downloaded. A young fund that does not yet have a requested 3Y, 5Y, or 10Y metric is retained; missing return history does not fail the filter. Missing AUM or dividend-yield data does fail an active catalog filter.

Example requiring a 5%–20% three-year CAGR and no more than 100% cumulative three-year return:

```bash
PERFORMANCE_3Y="5:20" \
TOTAL_RETURN_3Y=":100" \
bun scripts/update-ishares-data.ts
```

Every successful fund update stores the derived quarter-end `performance` and `totalReturn` values in `api/ishares/index.json` and the fund `meta.json`. Current holdings are exposed through stable numeric files under `api/ishares/funds/{TICKER}/holdings/`; historical NAV rows are exposed the same way under `history/` and are loaded lazily by the app. Page names are position-based (`001.json`, `002.json`, …), content-aware writes leave unchanged files untouched, and stale pages are removed after a successful refresh. The updater also removes obsolete flat `funds/{TICKER}.json` files and orphan fund directories after a sufficiently complete live catalog; a catalog fallback never removes fund directories. GitHub Actions also writes updated, unchanged, return-filtered, and failed counts to the workflow summary.
