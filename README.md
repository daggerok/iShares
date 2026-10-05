# iShares

One of the app's features lets you select iShares ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/ishares` static feed (iShares and BlackRock product-data SpreadsheetML (.xls) workbooks) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export — the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/iShares#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/iShares/>.

### Column types and filters

Every column of the ETF catalog and of the Watchlist, Holdings, History and Distributions tabs has a type: text (`ABC`), number (`123`), percentage (`%`), money (`$`), date (`D`), date and time (`DT`) or time of day (`T`). The type is detected from the texts the column shows (80% of the filled cells must agree, otherwise text) and is written in the badge next to the column title: click it to cycle the type, Shift+click to return to auto-detection. Dates are read as `2024-06-15`, `6/15/2024`, `15.06.2024`, `Jun 15, 2024` or `15-Jun-2024`, date and time as `2024-06-15T09:30:00Z` or `2024-06-15 09:30`, time as `09:30`, `16:00:00` or `9:30 PM`

A row of filter inputs sits under the column headers (the `Filters` button hides it, `Clear filters` empties it). Filters of different columns are combined with AND, the search box applies on top, and Copy Tickers and the exports use the filtered rows. Filters and type overrides are remembered in the browser. `Sticky #` (next to `Filters`, off by default, remembered in the browser) numbers the rows by their rank in the table sorted by the current column before the column filters, so a filtered fund keeps its rank and the numbers keep gaps; the sort, the search and the category and blacklist choices rank again. The catalog starts sorted by Net Assets, largest first, unavailable values sort last in both directions, and every export starts with the `#` column. The red `Clear` button forgets everything saved in the browser without asking, except the blacklist and the theme, so the page looks like a first visit (also after a reload)

Inside one filter: a space means AND, a comma means OR, a leading `!` means NOT, `?` matches an empty or unavailable value and `!?` a value that is there; a value that is unavailable matches only `?` and negated conditions. An unquoted space ends the value, so quote values that contain one (`>="2024-06-15 09:30"`)

| Type | Examples |
| --- | --- |
| Text | `bank` contains, `"two words"`, `!bank`, `=exact`, `^starts`, `ends$`, `/regex/`, `tech, health` |
| Number, percentage, money | `>10`, `>=10 <50`, `=22` (matches what rounds to 22), `!=22`, `10..50`, `..50`, `10..`, `>1B` and `K` `M` `B` `T` suffixes, an optional `$` or `%` |
| Date, date and time | `>2024-06-01`, `2024` (the whole year), `2024-06` (the whole month), `2024-01..2024-06`, `today`, `yesterday`, `-7d..` (the last 7 days), `+2w`, `-3m`, `-1y` |
| Time | `>09:30`, `09:30..16:00`, `=12:00` (the whole minute) |

The `Columns` menu next to `Filters` lists every column of the ETF table from the first to the last, all of them shown by default, with a search box and the `All`, `Clear`, `Toggle` and `Reset` buttons. `Use` and `Ticker` are listed but locked. Hiding a column only removes it from the table: the filters, the sorting, the exports and Copy Tickers still use it. The choice is remembered in the browser (localStorage, never the data) and the menu is shown on the ETF catalog only

The asset classes are one `Asset classes` multi-select next to the `All ETFs` pill instead of one tab per class: every class is selected by default (= all ETFs), `Only` or unchecking narrows the table, and the `All ETFs` pill is lit only while nothing narrows it (all or none of the classes checked); clicking the pill clears the selection. The choice is remembered in the browser (localStorage, never the data)

## Updating the static iShares data

Run the updater with Bun:

```bash
bun test
bun scripts/update-data.ts
```

Run `bun scripts/update-data.ts --help` to print every control with its default and usage examples.

Defaults live in `scripts/update-data.config.json` (every control, all values strings). An explicitly set environment variable overrides the file (an empty value clears the control); an `ISHARES_<KEY>` alias (for example `ISHARES_CONCURRENCY`) wins over the plain `<KEY>`, and the legacy `ISHARES_LIMIT` and `HISTORICAL_PAGE_SIZE` aliases still work. The **Update iShares ETF data** GitHub Actions workflow uses the same `resolveControls` function as the CLI: individual `workflow_dispatch` inputs are blank by default and inherit the file, and the `advanced` input accepts a JSON object with any control (for example `{"STORE_RAW_DOWNLOADS":"true"}`). Precedence: file defaults < advanced JSON < nonblank inputs < protected Actions variable or environment. Unknown keys, non-scalar values and multiline values are rejected. All supplied filters use **AND** logic.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all US iShares ETFs) | `https://www.ishares.com/us/products/etf-investments` (the product table, parsed from HTML) |
| Workbook per fund | `https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v1/get-fund-document?...&component=fundDownload` (SpreadsheetML workbook with the Holdings, Historical, Distributions and Performance worksheets) |
| Fund header | `https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v2/get-product-data?...&component=fundHeader` (30-day SEC yield, asset class and ISIN, iShares-published figures, not an EDGAR download) |
| Fallback | Previously published `api/ishares/index.json` as catalog fallback when live discovery fails |

All data comes from iShares and BlackRock; there is no Yahoo Finance or SEC EDGAR source.

**Feed layout**

`api/ishares/index.json` and `api/ishares/funds/<TICKER>/meta.json` use the same shapes as every sibling feed, so one shared application can sort and search all brands the same way:

- `index.json` has `generatedAt`, `source`, `counts` (`funds`, `holdings`, `history`) and one row per fund: `ticker`, `name`, `category`, `fundPage`, `dataFile`, `cusip`, `isin`, `ter` / `terValue` (plus `terGross` / `terGrossValue`), `nav` / `navValue`, `aum` / `aumValue` (net assets), `asOfDate`, `inceptionDate`, `distributions`, `returns` (`monthEnd`, `quarterEnd`), `metrics`, `holdings` and `history` row counts
- `meta.json` holds `providerIds`, `source`, `identifiers`, `inception`, `expenseRatio`, `nav`, `aum`, `yields`, `returns`, `officialReturns`, `distributions` (frequency plus the full distribution table), the `holdings` and `history` page manifests and the monthly `Performance` worksheet
- holdings and history stay as paged files in the iShares column layout (`Weight (%)`, `NAV per Share`, ...)
- `category` is the iShares asset class from the product header (Equity, Fixed Income, Commodity, Multi-asset, Real Estate, Digital Assets); when the header gives none it is derived from the holdings market-value mix, and `meta.source.categorySource` says which one was used
- `cusip` is taken from a US `isin`; both are `null` until the updater has read the product header of the fund
- the exchange, closing price and premium/discount are `null` or `—`: iShares publishes NAV history only

### Metrics and caveats

Each fund carries a `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` - year-to-date NAV total return up to the latest quarter end
- `tr1y` / `tr3y` / `tr5y` / `tr10y` - cumulative NAV total returns -> *TR 1Y/3Y/5Y/10Y*
- `cagr3y` / `cagr5y` / `cagr10y` - annualized 3Y/5Y/10Y NAV total returns -> *CAGR 3Y/5Y/10Y*
- `siAnn` - since-inception annualized return -> *SI Ann.*; `null` until the fund has 12 contiguous months of NAV returns (a shorter history is never extrapolated to a yearly rate) and when the monthly series has a gap
- `dividendYield` / `dividendYieldText` - 12-month trailing yield published in the product table
- `dividendYieldBasis` - code of the definition behind `dividendYield`, `null` exactly when the yield is `null` (table below)
- `secYield` / `secYieldText` - 30-day SEC yield when published; `—` otherwise
- `returnsBasis` - the basis of every return figure: official iShares NAV total returns, compounded from the published monthly NAV return series up to the latest quarter end
- `performanceAsOf` - ISO date of that quarter end, `null` when no returns are available

| `dividendYieldBasis` | Meaning for iShares |
| --- | --- |
| `official-trailing-12m` | the 12-month trailing yield published in the ishares.com product table (the only yield source) |
| `official-distribution-rate`, `official-other`, `computed-trailing-12m`, `indicated` | never emitted: iShares publishes no other yield and the updater computes none |
| `null` | no yield published |

Percentages are plain numbers (`10.19` means 10.19%). An unavailable value is `null` (text fields `—`), never `0`. The returns date is the quarter end shown in the *Return As Of* column, so it can trail the NAV date. A configured filter also skips funds that do not publish the filtered metric. A fund is either fully updated or fully kept: when its download fails, or its Holdings worksheet is empty although holdings were published before, the previous files stay as they were. Physical metal trusts (IAU, IAUM, SLV) publish no securities list, so an empty Holdings worksheet is valid for them and the fund still updates NAV, net assets, returns and history (`meta.holdings.status` is `empty`). A transient failure of the fund-header request keeps the previously published 30-day SEC yield. Funds not selected for an update keep their prior metadata and data files. A fund that vanishes from the live catalog is removed only when at most three (or 2%) vanish at once; a partly parsed catalog page never deletes funds. New catalog tickers are printed as `NEW FUNDS: A, B` and appended to the job summary. Every request has a 120 s timeout, JSON files are written through a temporary file and a rename, stale pages are removed after the new `meta.json`, and a rerun with unchanged upstream data writes nothing, not even `generatedAt`. The run stops taking new funds after 25 minutes and still writes the index; it exits non-zero when every attempted fund failed. With `STORE_RAW_DOWNLOADS` the source workbook is kept as `api/ishares/raw/{TICKER}.xls`.

### Update controls

| Environment variable | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | all | Batch size (integer >= 0, strict digits): with a positive value the updater continues after the committed cursor in `api/ishares/update-state.json`; empty or `0` is a full pass, every fund is refreshed in one run. |
| `REQUEST_SLEEP` | `0` | Minimum delay in seconds between outgoing request starts, including retries. |
| `CONCURRENCY` | `4` | Number of parallel fund update workers; every worker has its own request lane and `REQUEST_SLEEP` is kept per lane. |
| `AUM` | `:` | Net Assets range. Each bound may be a USD amount or `K`/`M`/`B`/`T`, or one of `nano`, `micro`, `small`, `mid`, `large`. |
| `TER` | `:` | Net expense ratio percentage range (gross when net is not published); funds without it are skipped when set. |
| `DIVIDEND_YIELD` | `:` | Dividend-yield percentage range. |
| `SEC_YIELD` | `:` | 30-day SEC yield percentage range, checked after the fund header is read; funds that do not publish it are skipped when set. |
| `TICKERS` | all | Space-, comma- or semicolon-separated ticker allowlist, e.g. `IVV DGRO DVY HDV`; a ticker that is not in the catalog is an error. |
| `PERFORMANCE_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Average-annual NAV performance ranges in % (the colon is required). |
| `TOTAL_RETURN_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Cumulative NAV total-return ranges in % (the colon is required). |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated historical NAV JSON page. |
| `STORE_RAW_DOWNLOADS` | `false` | Keep the source XLS workbooks (`true`/`yes`/`on`/`1`). |
| `MAX_RETRIES` | `2` | Retries after the initial request (integer >= 1). Only network errors and HTTP 408/425/429/5xx are retried with exponential backoff. |
| `VERBOSE` | `false` | Print per-fund retry and fallback notices. |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment. |

`TICKERS` combines with the AUM, yield and return filters using AND logic; it does not override them.

### Examples

```bash
MAX_FETCHES=10 bun scripts/update-data.ts
TICKERS="IVV DGRO DVY HDV" bun scripts/update-data.ts
AUM="1B:" DIVIDEND_YIELD="2:" bun scripts/update-data.ts
PERFORMANCE_1Y="15:" bun scripts/update-data.ts
```

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone - no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

`bun test` also covers the config, `--help` and README parity and the workflow shape

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) |
| **Parametric** | [eatonvance.com](https://www.eatonvance.com/products/etfs.html) \| [Parametric](https://daggerok.github.io/Parametric/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SP Funds** | [sp-funds.com](https://www.sp-funds.com/) \| [SP-Funds](https://daggerok.github.io/SP-Funds/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs Firestore data feed + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com fund pages and sitemap + official Invesco fund API (monthly returns, NAV, AUM, yields, daily holdings, expense ratio) + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| Parametric | eatonvance.com ETF catalog and Parametric product pages + SEC EDGAR N-PORT-P holdings + Yahoo Finance history/dividends | [Parametric](https://github.com/daggerok/Parametric) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SP Funds | sp-funds.com homepage catalog, fund pages and daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [SP-Funds](https://github.com/daggerok/SP-Funds) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT - same as all sibling ETF repositories.](./LICENSE)

iShares® and BlackRock® and the fund names/tickers referenced here are trademarks of BlackRock, Inc. or its affiliates. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by BlackRock or iShares. All data is reproduced from iShares' own public downloads for research purposes. All other trademarks, including index names, are the property of their respective owners.
