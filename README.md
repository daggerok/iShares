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

Run `./scripts/update-data.ts -h` (or `--help`) to print every configuration variable with its default and usage examples, e.g. `TOTAL_RETURN_1Y="15:" ./scripts/update-data.ts` updates only funds whose 1-year Total Return (TR 1Y) is at least 15%.

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
- Any ETF can be **blacklisted**: click the small ✕ next to a fund's Use checkbox or type tickers into the **Blacklist** panel in the toolbar. Blacklisted ETFs disappear from All ETFs (and from selection); the list is kept per browser in localStorage and can be edited or cleared in the same panel.
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

## Brands table

| Бренд                        | Фонды | Где брать данные |
|------------------------------|---|---|
| **SPDR / State Street** (14) | SPYM, SPYG, SPYD, SDY, XTL, XLK, XLF, XLV, XLY, XLU, XLC, XLI, XLP, XLE | [us.spdrs.com](https://us.spdrs.com/) · [каталог ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) · секторы: [selectsectorspdrs.com](https://www.selectsectorspdrs.com/) |
| **Invesco** (14)             | QQQM, RSP, SPLV, SPHD, SPMO, SPHQ, SPGP, RPV, RPG, RWL, DBA, IDMO, IDHQ, IDLV | [invesco.com `?ticker=`](https://www.invesco.com/us/financial-products/etfs/product-detail?ticker=IDHQ) |
| **iShares / BlackRock** (14) | IVV, SGOV, DGRO, SOXX, MTUM, DVY, HDV, IAUM, PICK (Global Metals & Mining), GARP (MSCI USA Quality GARP), SLVP (Global Silver Miners), RING (Global Gold Miners) | [www.ishares.com](https://www.ishares.com/) · XLS-экспорт holdings со страниц фондов (уже интегрирован в наше приложение, весь каталог)
| **Vanguard** (10)            | VOO, VUG, VTV, VIG, VYM, VGT, MGK, VOOG, VIGI, VYMI | [investor.vanguard.com](https://investor.vanguard.com/investment-products/etfs) → `…/profile/VOO` |
| **Fidelity** (5)             | FTEC, FDVV, FDIS, FCOM, FNILX* | [fidelity.com/etfs](https://www.fidelity.com/etfs) · [fundresearch.fidelity.com](https://fundresearch.fidelity.com/) — *FNILX вообще не ETF, а взаимный фонд ZERO |
| **Schwab** (3)               | SCHD, SCHG, SCHB | [schwabassetmanagement.com/products/schd](https://www.schwabassetmanagement.com/products/schd) |
| **VanEck** (3)               | SMH, GDX, GDXJ | [vaneck.com/etf/smh/](https://www.vaneck.com/etf/smh/) |
| **Amplify** (3)              | DIVO, IDVO (CWP Intl Enhanced Dividend), SILJ (Junior Silver Miners, экс-ETFMG) | [amplifyetfs.com](https://amplifyetfs.com/) · Firestore-фид данных (уже интегрирован в наше приложение)
| **JPMorgan** (2)             | JEPI, JEPQ | [JEPI](https://am.jpmorgan.com/us/en/asset-management/adv/products/jpmorgan-equity-premium-income-etf-etf-shares-46641q332) · [JEPQ](https://am.jpmorgan.com/us/en/asset-management/adv/products/jpmorgan-nasdaq-equity-premium-income-etf-etf-shares-46654q203) |
| **Global X** (2)             | URA, SIL | [globalxetfs.com/funds/ura/](https://www.globalxetfs.com/funds/ura/) |
| **abrdn** (2)                | SGOL, SIVR | [abrdn.com](https://www.abrdn.com) → Investments → ETFs |
| **NEOS** (2)                 | SPYI, QQQI | [neosfunds.com](https://neosfunds.com/) |
| **Goldman Sachs** (2)        | GPIX, GPIQ | [GSAM.com/ETFs](https://www.gsam.com/etfs) |
| **Sprott** (2)               | SGDM, SGDJ | [sprott.com/investments](https://sprott.com/investments/) |
| **First Trust** (1)          | RDVY | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etfsummary.aspx?ticker=RDVY) |
| **WisdomTree** (1)           | DGRW | [wisdomtree.com/investments/etfs/dgrw](https://www.wisdomtree.com/investments/etfs/dgrw) |
| **Capital Group** (1)        | CGDV | [capitalgroup.com/etf/cgdv.html](https://www.capitalgroup.com/etf/cgdv.html) |
| **FlexShares** (1)           | GUNR | [flexshares.com/us/en/individual/funds/gunr](https://www.flexshares.com/us/en/individual/funds/gunr) |
| **Roundhill** (1)            | DRAM | [roundhillinvestments.com/etf/dram/](https://www.roundhillinvestments.com/etf/dram/) |
| **ProShares** (1)            | ISPY | [proshares.com](https://www.proshares.com/our-etfs/strategic/ispy) |
| **Themes ETFs** (1)          | AGMI | [themesetfs.com/etfs/agmi](https://themesetfs.com/etfs/agmi) |
| **SP Funds** (1)             | SPWO (шариат-фонд) | [sp-funds.com](https://www.sp-funds.com/) |

## Brands list

#	Бренд	Фонды из списка (кол-во)	Официальный сайт / страницы фондов
1	SPDR / State Street — 14	SPYM (бывш. SPLG), SPYG, SPYD, SDY, XTL + секторы XLK, XLF, XLV, XLY, XLU, XLC, XLI, XLP, XLE	https://us.spdrs.com/ · каталог: https://www.ssga.com/us/en/intermediary/etfs/fund-finder · секторы: https://www.selectsectorspdrs.com/
2	Invesco — 14	QQQM, RSP, SPLV, SPHD, SPMO, SPHQ, SPGP, RPV, RPG, RWL, DBA, IDMO, IDHQ, IDLV	https://www.invesco.com/us/financial-products/etfs/product-detail?ticker=IDHQ (паттерн ?ticker={TICKER})
3	iShares (BlackRock) — 12 ✅	IVV, SGOV, DGRO, SOXX, MTUM, DVY, HDV, IAUM, PICK (Global Metals & Mining), GARP (MSCI USA Quality GARP), SLVP (Global Silver Miners), RING (Global Gold Miners)	https://www.ishares.com/ — XLS-экспорт holdings со страниц фондов (уже интегрирован в наше приложение, весь каталог)
4	Vanguard — 10	VOO, VUG, VTV, VIG, VYM, VGT, MGK, VOOG, VIGI, VYMI	https://investor.vanguard.com/investment-products/etfs — профиль фонда: …/etfs/profile/VOO
5	Fidelity — 5	FTEC, FDVV, FDIS, FCOM, FNILX*	https://www.fidelity.com/etfs · исследование: https://fundresearch.fidelity.com/ (*FNILX — взаимный фонд ZERO, не ETF)
6	Schwab Asset Management — 3	SCHD, SCHG, SCHB	https://www.schwabassetmanagement.com/products/schd (паттерн /products/{ticker})
7	VanEck — 3	SMH, GDX, GDXJ	https://www.vaneck.com/etf/smh/ (паттерн /etf/{ticker}/)
8	Amplify — 3 ✅	DIVO, IDVO (CWP Intl Enhanced Dividend), SILJ (Junior Silver Miners, экс-ETFMG)	https://amplifyetfs.com/ — Firestore-фид данных (уже интегрирован в наше приложение)
9	JPMorgan Asset Management — 2	JEPI, JEPQ	https://am.jpmorgan.com/us/en/asset-management/adv/products/jpmorgan-equity-premium-income-etf-etf-shares-46641q332 · …/jpmorgan-nasdaq-equity-premium-income-etf-etf-shares-46654q203
10	Global X — 2	URA, SIL	https://www.globalxetfs.com/funds/ura/ (паттерн /funds/{ticker}/)
11	abrdn — 2	SGOL, SIVR	https://www.abrdn.com (раздел Investments → ETFs; физическое золото/серебро, daily bar list)
12	NEOS — 2	SPYI, QQQI	https://neosfunds.com/ · https://neosfunds.com/spyi-lp/ · https://neosfunds.com/qqqi-lp/
13	Goldman Sachs (GSAM) — 2	GPIX, GPIQ	https://www.gsam.com/etfs (GSAM.com/ETFs) · GPIX: https://www.gsam.com/content/gsam/us/en/advisors/fund-center/etf-fund-finder/goldman-sachs-s&p-500-core-premium-income-etf.html
14	Sprott — 2	SGDM, SGDJ	https://sprott.com/investments/ · https://api.sprott.com/sgdm-sprott-gold-miners-etf/ · …/sgdj-sprott-junior-gold-miners-etf/
15	First Trust — 1	RDVY (Rising Dividend Achievers)	https://www.ftportfolios.com/Retail/etf/etfsummary.aspx?ticker=RDVY
16	WisdomTree — 1	DGRW	https://www.wisdomtree.com/investments/etfs/dgrw
17	Capital Group — 1	CGDV (Dividend Value)	https://www.capitalgroup.com/etf/cgdv.html (паттерн /etf/{ticker}.html)
18	FlexShares (Northern Trust) — 1	GUNR	https://www.flexshares.com/us/en/individual/funds/gunr
19	Roundhill — 1	DRAM (Memory ETF, зап. 04/2026)	https://www.roundhillinvestments.com/etf/dram/
20	ProShares — 1	ISPY (S&P 500 High Income)	https://www.proshares.com/our-etfs/strategic/ispy
21	Themes ETFs — 1	AGMI (Silver Miners)	https://themesetfs.com/etfs/agmi (паттерн /etfs/{ticker})
22	SP Funds (ShariaPortfolio) — 1	SPWO (S&P World ex-US, шариат)	https://www.sp-funds.com/
