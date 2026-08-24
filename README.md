# iShares

## Using Bun

```bash
bunx degit daggerok/iShares#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/iShares/>.

## Updating the static iShares data

Run the updater with Bun:

```bash
bun test scripts/update-data.test.ts
./scripts/update-data.ts
```

The **Update iShares ETF data** GitHub Actions workflow exposes the same settings as manual inputs. All supplied filters use **AND** logic.

### Update controls

| Environment variable | Default | Meaning |
|---|---:|---|
| `MAX_FETCHES` | all | Maximum eligible fund update attempts per run. With a positive value, the updater continues after the committed cursor in `api/ishares/update-state.json`; empty or `0` means all. The legacy `ISHARES_LIMIT` name remains supported. |
| `REQUEST_SLEEP` | `0` | Minimum delay in seconds between outgoing request starts, including retries. Decimal values are accepted. |
| `AUM` | `:` | Net Assets range. Each bound may be a USD amount or `nano`, `micro`, `small`, `mid`, or `large`. |
| `CONCURRENCY` | `4` | Number of parallel fund update workers. Request starts are still globally spaced by `REQUEST_SLEEP`. |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated historical NAV JSON page. `HISTORICAL_PAGE_SIZE` remains supported as an alias. |
| `STORE_RAW_DOWNLOADS` | off | Store the latest source XLS under `api/ishares/raw`. Values `1`, `true`, `yes`, `y`, and `on` enable it. The legacy `ISHARES_STORE_RAW_DOWNLOADS` name remains supported. |
| `MAX_RETRIES` | `2` | Retries after the initial request. The default permits at most three attempts total. Only network errors, HTTP 408/425/429, and 5xx responses are retried with bounded exponential backoff. |
| `TICKERS` | all | Space-, comma-, or semicolon-separated ticker allowlist, for example `IVV DGRO DVY`. |
| `DIVIDEND_YIELD` | `:` | Inclusive 12-month trailing dividend-yield percentage range. |

`TICKERS` combines with AUM, dividend-yield, and return filters using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files.

### Resuming bounded runs

A positive `MAX_FETCHES` is a batch size, not a permanent first-page limit. Eligible funds are kept in deterministic ticker order and the updater starts after `lastProcessedTicker` in `api/ishares/update-state.json`, wrapping to the beginning when it reaches the end. The state file is updated only for a bounded run that had candidates, so committing it lets the next run continue with the next batch. Delete that file to restart from the first eligible ticker. `MAX_FETCHES=0` still processes every eligible fund and does not move the bounded-run cursor.

The committed cursor currently ends at `BEMB`, matching the 20-fund batch already present in the catalog; therefore the next default `MAX_FETCHES=20` run starts at the next ticker. A batch may still change up to 20 metadata files when those funds have new source data or have not yet received the fixed-size derived `returns` block. The `returns` block is replaced in place, never appended. Historical and distribution rows grow only when iShares publishes new rows, and paginated files grow only when a page-size boundary is crossed.

### Strict range syntax

Every non-empty range must contain **exactly one colon**. Empty input and `:` both mean no restriction.

| Value | Valid | Meaning |
|---|:---:|---|
| empty | yes | no restriction |
| `:` | yes | no restriction |
| `:900000` | yes | maximum 900000 |
| `12345678:123456789` | yes | inclusive minimum and maximum |
| `1234567:` | yes | minimum 1234567 |
| `123456789` | **no** | colon is missing |

For ordinary numeric ranges, including dividend yield and returns, both bounds are inclusive. Percent signs are optional, so `1%:4.5%` and `1:4.5` are equivalent. A configured minimum must not exceed its maximum.

### AUM ranges and presets

`AUM` replaces separate minimum, maximum, and preset controls. Numeric AUM bounds accept plain USD amounts or `K`, `M`, `B`, and `T` suffixes.

Preset boundaries are:

```text
nano:     $0 <= AUM < $10M
micro:    $10M <= AUM < $300M
small:    $300M <= AUM < $2B
mid:      $2B <= AUM < $10B
large:    AUM >= $10B
```

A preset on the left contributes its lower boundary. A preset on the right contributes its exclusive upper boundary:

| AUM value | Meaning |
|---|---|
| `micro:small` | `$10M <= AUM < $2B` |
| `small:small` | `$300M <= AUM < $2B` |
| `large:` | `AUM >= $10B` |
| `:micro` | `AUM < $300M` |
| `300M:2B` | `$300M <= AUM <= $2B` because numeric maxima are inclusive |
| `:` or empty | no AUM restriction |

A colonless number or preset is invalid. For example, `123456789`, `mid`, and `all` are rejected. Use `:` instead of `all`.

### Performance and total-return ranges

The following variables use the same strict `min:max` syntax:

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

Examples:

```text
5:20   from 5% through 20%, inclusive
5:     at least 5%
:20    at most 20%
:      no restriction
```

A colonless value such as `5` is invalid.

`PERFORMANCE_1Y`, `PERFORMANCE_3Y`, `PERFORMANCE_5Y`, and `PERFORMANCE_10Y` use average-annual NAV total return. The multi-year values are period-specific **CAGR** values. A standalone `TOTAL_RETURN_CAGR` is intentionally not provided because CAGR is meaningless without a period.

`TOTAL_RETURN_*` uses cumulative NAV total return for the selected period. iShares does not publish an annualized YTD value, so both `PERFORMANCE_YTD` and `TOTAL_RETURN_YTD` use cumulative YTD NAV total return. One-year annualized and one-year cumulative return are likewise mathematically equal.

Metrics are derived from the official workbook's monthly NAV total-return series at its latest available quarter end. **SI Ann.** is the same series compounded from the first available month through that quarter-end, then annualized. Latest **NAV** comes from the first historical-NAV row. Return filters are evaluated after that workbook is downloaded. A young fund that does not yet have a requested 3Y, 5Y, or 10Y metric is retained; missing return history does not fail the filter. Missing AUM or dividend-yield data does fail an active catalog filter. SI Ann. is catalog-only and is not a filter variable.

### Examples

Update only three dividend ETFs with at least $300M AUM and no more than a 4% trailing yield:

```bash
TICKERS="IVV DGRO DVY" \
MAX_RETRIES=2 \
REQUEST_SLEEP=0.5 \
AUM="300M:" \
DIVIDEND_YIELD=":4" \
CONCURRENCY=3 \
bun scripts/update-data.ts
```

Require a 5%–20% three-year CAGR and no more than 100% cumulative three-year return:

```bash
PERFORMANCE_3Y="5:20" \
TOTAL_RETURN_3Y=":100" \
bun scripts/update-data.ts
```

## Developer notes

- Updater controls belong to `workflow_dispatch` and are visible on the GitHub Actions **Run workflow** form. They are not controls in the published web application.
- The workflow is manual. Merging updater code changes does not run a data update automatically.
- A successful data run may commit only `api/ishares/**`. GitHub Pages then deploys that commit, but the catalog UI changes only when the generated data itself changed.
- Catalog-only filters (`TICKERS`, `AUM`, and `DIVIDEND_YIELD`) run before `MAX_FETCHES`. Return filters run after each selected official workbook is downloaded and parsed.
- Every successful fund update stores derived quarter-end `performance` and `totalReturn` values (including since-inception `SI`) plus latest `nav` in `api/ishares/index.json` and under `returns` in the fund's `meta.json`.
- Each fund update also downloads the product-page `fundHeader` component and stores the published 30-Day `secYield` (with `secYieldAsOf`) in `index.json` and in the fund's `meta.json`. Commodity and digital-asset funds (for example `IAU`, `SLV`, `IBIT`) do not publish the datapoint and keep `—`.
- The UI fetches the first Holdings and Historical pages and appends more rows automatically as the table is scrolled; it does not show page-number controls.
- The **Watchlist** tab aggregates the holdings of every selected ETF. Its **# ETFs** column counts how many of the selected ETFs currently hold each ticker, right after the **ETFs** badge column.
- The app keeps search and sort preferences in localStorage, reapplies them after reload, and clears the cached workbook before reloading when `Clear` is clicked.
- GitHub Actions writes updated, unchanged, return-filtered, and failed counts to the workflow summary.
- Updater logs are aligned (`[fund    ] ticker=IAU  168/480 status=unchanged`): one line per fund with its final status. Fund `start` lines and first-attempt `[fetch]` lines are suppressed; retries (`attempt=2/3`, `[retry]`), `[yield]` gaps, and `status=failed reason=…` stay visible.
- Range validation is centralized in `parseRange`; AUM's numeric/preset validation is centralized in `parseAumRange`. Add or change syntax there and update `scripts/update-data.test.ts` in the same PR.

Before opening a PR, run:

```bash
bun install --frozen-lockfile
bun test scripts/update-data.test.ts
bunx tsc --noEmit \
  --target es2022 \
  --module esnext \
  --moduleResolution bundler \
  --types bun,node \
  --skipLibCheck \
  scripts/update-data.ts \
  scripts/update-data.test.ts

git diff --check
```
