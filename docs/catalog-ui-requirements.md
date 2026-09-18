# Catalog UI implementation plan: distribution frequency column + pinned columns

This plan is for whoever implements the two features below in the **iShares**
watchlist app. Read this whole document before touching code — it is written
to be followed mechanically, with exact file paths, function names, and
paste-ready code for this repo specifically. Do not port code from another
provider repo verbatim; the snippets below are already adapted to iShares.

## 0. Architecture facts you need before starting

- **There is no `app.tsx` in this repo.** Unlike the SPDR sibling app, iShares
  keeps its entire markup, `<style>` block, and TypeScript app logic in one
  file: `index.html` (2732 lines). The JS lives inline in a plain
  `<script>` block starting at line 455 (not even a Babel/JSX block — this
  app is plain JS/TS-flavored JSDoc, no `text/babel`). All catalog-table
  changes for feature 2 go in `index.html`. Feature 1 also touches
  `scripts/update-data.ts` (see below) because the raw data needed for the
  column does not exist client-side today.
- **`.parcel-cache/` and `dist/` are stale, non-load-bearing cruft.** Both
  are listed in `.gitignore` and are not tracked. `package.json` has no
  Parcel dependency at all — its only scripts are `test` (`bun test
  scripts/update-data.test.ts`) and `update` (`bun scripts/update-data.ts`).
  The app runs as a static, no-build page: Tailwind via the CDN script
  (`<script src="https://cdn.tailwindcss.com">`) plus plain inline
  JavaScript — there is no bundler step in the real workflow. **Do not spend
  any effort wiring a Parcel build; just edit `index.html` directly** and
  reload it (or serve the repo root with any static file server) to see
  changes.
- The catalog table, the Watchlist tab, and every per-fund detail sheet
  (Holdings / Historical / Performance / Distributions) all render through
  the **same** `<table>` inside `#table-scroll` (`index.html:410-450`), via
  the shared `tableHead`/`tableBody` DOM refs (`index.html:734` and
  neighboring lines) and the generic `renderTable()` function
  (`index.html:2166`). Any CSS you scope to `#table-scroll` reaches all of
  these views — this matters a lot for feature 2.
- Theme: dark mode is a `.dark` class on `<html>`, persisted with
  `localStorage` key **`ishares-theme`** (`index.html:39` and `:616`,
  `const THEME_KEY = "ishares-theme"`). Page background is set directly in
  the anti-FOUC script to `#020617` (dark) / `#f8fafc` (light).

## 1. Distribution frequency column

### Current state: no frequency column, and no raw frequency field exists yet

Checked both the client (`index.html`) and the data pipeline
(`scripts/update-data.ts`, `api/ishares/index.json`, a sample
`api/ishares/funds/AGG/meta.json`):

- The **catalog** table's column list is `staticCatalogSheet.headers` in
  `index.html`, built at `index.html:1393-1417`:
  ```
  Ticker, Fund Name, Type, NAV, Net Assets, Expense, Dividend Yield,
  SEC Yield, YTD Return, TR 1Y, TR 3Y, TR 5Y, TR 10Y, CAGR 3Y, CAGR 5Y,
  CAGR 10Y, SI Ann., Return As Of, Inception, Holdings, History, As Of
  ```
  There is no frequency-like column today. **`SEC Yield` and `YTD Return`
  already exist as adjacent real columns** in exactly this order, so the
  generic placement rule ("after SEC Yield, before YTD Return") maps
  directly onto this repo with no substitution needed.
- The per-fund catalog data (`api/ishares/index.json`, consumed as `fund` in
  `index.html:1418-1445`) has no `frequency`/`distribution` field of any
  kind — confirmed by inspecting a live fund entry (`AAXJ`): fields present
  are `trailingYield`, `secYield`, `ytdReturn`, `totalReturn`, `performance`,
  etc., nothing about distribution cadence.
- iShares' feed genuinely does **not** publish a discrete "distribution
  frequency" label the way some other providers do. What it does publish,
  per fund, is a **`Distributions` worksheet** inside the SpreadsheetML
  `.xls` export that `scripts/update-data.ts` already downloads and parses
  (`parseWorkbook()`, `scripts/update-data.ts:613`). You can see its real
  shape in `api/ishares/funds/AGG/meta.json`, under
  `worksheets.Distributions`:
  ```json
  "Distributions": {
    "headers": ["Record Date", "Ex-Date", "Payable Date", "Total Distribution",
                "Income", "ST Cap Gains", "LT Cap Gains", "Return of Capital"],
    "rows": [
      { "Record Date": "Sep 01, 2026", "Ex-Date": "Sep 01, 2026",
        "Payable Date": "Sep 04, 2026", "Total Distribution": "0.337062", ... },
      { "Record Date": "Aug 03, 2026", ... },
      { "Record Date": "Jul 01, 2026", ... },
      ...
    ]
  }
  ```
  This is a list of individual distribution payments (one row per payout),
  newest first — not a single cadence label. The frequency must be
  **derived from the spacing/count of these rows**, not read off a field
  that doesn't exist.
- This `Distributions` worksheet is already fetched today (it's part of the
  same `.xls` download used for Holdings/History/Performance) and is kept
  in each fund's `meta.json` for the existing per-fund **Distributions**
  detail tab (`index.html` tab list at `index.html:951`, `:1213`, `:1286`,
  `:2084`; label built at `index.html:1925-1926`). **No second data source
  or new HTTP request is needed** — this satisfies the "don't add a second
  data source" principle by computing the cadence once, at data-update
  time, from data the pipeline already downloads for another purpose.
- The catalog list (`api/ishares/index.json`) is generated separately from
  each fund's full `meta.json` and currently only receives a curated subset
  of fields via `result.indexFields` (see `scripts/update-data.ts:965-986`,
  merged into the index at `scripts/update-data.ts:1240`). The
  `Distributions` worksheet itself is **not** copied into `indexFields`
  today — only a derived scalar needs to be added there.

### The gap and the plan to close it

Because the raw distribution history only exists in each fund's full
`meta.json` (fetched lazily per fund) and not in the aggregate
`index.json` (used to render the catalog table for all ~480 funds at once),
the frequency **must be computed once, server-side, during the `bun
scripts/update-data.ts` data-update run**, and stored as a small derived
field in `index.json`. Do not try to compute it client-side by fetching all
funds' `meta.json` up front — that would be ~480 extra requests just to
render the catalog and defeats the existing lazy-loading design.

#### Step 1.1 — add a pure derivation function to `scripts/update-data.ts`

Add this near `deriveReturnMetrics` (around `scripts/update-data.ts:651`),
following the same exported-pure-function style so it can be unit tested
the same way `deriveReturnMetrics`/`parseSecYield` are tested in
`scripts/update-data.test.ts`:

```ts
/**
 * Derive a sortable "NN - Label" distribution-cadence code from a fund's own
 * Distributions worksheet rows (already downloaded for the per-fund
 * Distributions detail tab — see parseWorkbook()). iShares' SpreadsheetML
 * export does not publish a discrete "frequency" field the way some other
 * providers do, so the cadence is derived here, once, at data-update time
 * from the payment dates already on hand — never recomputed in the browser
 * and never fetched from a second source.
 */
export function deriveDistributionFrequency(distributions?: Sheet): string {
  const headers = distributions?.headers ?? [];
  const dateHeader = headers.find((h) =>
    ["payable date", "ex-date", "record date"].includes(
      h.trim().toLowerCase(),
    ),
  );
  const rows = distributions?.rows ?? [];
  if (!rows.length || !dateHeader) return "00 - Unknown";

  const timestamps = rows
    .map((row) => Date.parse(`${row[dateHeader]} UTC`))
    .filter((ts) => Number.isFinite(ts))
    .sort((a, b) => b - a);
  if (!timestamps.length) return "00 - Unknown";

  const newest = timestamps[0];
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  const trailing12m = timestamps.filter((ts) => newest - ts <= oneYearMs);
  const count = trailing12m.length;

  // A fund with under a year of total history can't be classified reliably
  // from a partial year — report Unknown instead of guessing.
  if (timestamps.length < 3 && count < 3) return "00 - Unknown";

  if (count === 0) return "00 - None";
  if (count === 1) return "12 - Annually";
  if (count === 2) return "06 - Semi-annually";
  if (count >= 3 && count <= 5) return "04 - Quarterly";
  if (count >= 11) return "01 - Monthly";
  return "99 - Irregular";
}
```

This keeps the same `00`/`99` conventions as the generic spec: `00 -
Unknown` / `00 - None` for unavailable/no-distribution funds, `99 -
Irregular` for cadences that don't cleanly bucket, and zero-padded numeric
prefixes (`01`, `04`, `06`, `12`) everywhere else, so ascending string sort
stays meaningful (verified below).

The thresholds are a heuristic — tune the boundaries if real data shows
misclassification, but keep the output format (`"NN - Label"`) and the
`00`/`99` conventions exactly as specified, since the catalog column and
CSV/TXT export both depend on that exact string shape.

#### Step 1.2 — call it in `updateFund()` and add it to `indexFields`

In `updateFund()` (`scripts/update-data.ts:869`), alongside the existing
`holdingsName`/`historyName` lookups (`scripts/update-data.ts:893-899`), add:

```ts
const distributionsName = Object.keys(worksheets).find(
  (name) => name.trim().toLowerCase() === "distributions",
);
const distributions = distributionsName
  ? worksheets[distributionsName]
  : undefined;
const distributionFrequency = deriveDistributionFrequency(distributions);
```

Important: unlike `holdingsName`/`historyName`, **do not** `delete
worksheets[distributionsName]` — the Distributions worksheet must stay in
`document.worksheets` so it keeps populating the existing per-fund
Distributions detail tab.

Then add the field to the `indexFields` object returned from `updateFund()`
(`scripts/update-data.ts:973-985`):

```ts
indexFields: {
  dataFile: `./funds/${fund.ticker}/meta.json`,
  asOfDate,
  holdings: holdings.rows.length,
  history: history?.rows.length || 0,
  secYield: secYield?.value ?? "",
  secYieldAsOf: secYield?.asOf ?? "",
  distributionFrequency,
  nav: navValue === null ? "—" : `$${navValue.toFixed(2)}`,
  navValue,
  navAsOf: latestNavRow["As Of"] || "",
  performance: { asOfDate: returns.asOfDate, ...returns.performance, SI: returns.siAnn },
  totalReturn: { asOfDate: returns.asOfDate, ...returns.totalReturn, SI: returns.siCum },
},
```

This field flows automatically into `api/ishares/index.json` through the
existing spread at `scripts/update-data.ts:1240`
(`{ ...(prior || {}), ...freshFund, ...result.indexFields }`) — no other
pipeline change is needed. After the next `bun run update`, each fund
object in `index.json` will carry a `distributionFrequency` string like
`"01 - Monthly"`.

Add a unit test in `scripts/update-data.test.ts` (same file/import style as
the existing `deriveReturnMetrics`/`parseSecYield` tests) covering: monthly
cadence (≥11 payments/year), quarterly, semi-annual, annual, no
distributions, and a too-young/insufficient-history fund.

#### Step 1.3 — surface it in the catalog table (`index.html`)

In `staticCatalogSheet` (`index.html:1393-1417`), insert `"Frequency"`
between `"SEC Yield"` and `"YTD Return"` in the `headers` array:

```js
staticCatalogSheet = {
  headers: [
    "Ticker",
    "Fund Name",
    "Type",
    "NAV",
    "Net Assets",
    "Expense",
    "Dividend Yield",
    "SEC Yield",
    "Frequency",
    "YTD Return",
    "TR 1Y",
    ...
```

And in the `data:` row-mapping (`index.html:1418-1445`), insert the field in
the same position, reading directly from the value computed server-side —
**do not recompute or reparse anything client-side**:

```js
data: (index.funds || []).map((fund) => {
  const totalReturn = fund.totalReturn || {};
  const performance = fund.performance || {};
  return {
    Ticker: fund.ticker,
    "Fund Name": fund.name,
    Type: fund.type || "iShares ETF",
    NAV: fund.nav || "—",
    "Net Assets": fund.netAssets || "—",
    Expense: fund.netExpenseRatio || fund.grossExpenseRatio || "—",
    "Dividend Yield": fund.trailingYield || "—",
    "SEC Yield": fund.secYield || "—",
    Frequency: fund.distributionFrequency || "00 - Unknown",
    "YTD Return": formatPercent(totalReturn.YTD ?? fund.ytdReturn),
    ...
```

#### Step 1.4 — header tooltip

Add an entry to `COLUMN_TOOLTIPS` (`index.html:470`, alongside the
`"SEC Yield"` entry near `index.html:528`):

```js
Frequency:
  "Distribution Frequency — Cash-distribution cadence derived from the fund's own Distributions history (Record/Ex/Payable Date rows in the iShares SpreadsheetML export). Sortable numeric prefix: 00 = Unknown/None, 01 = Monthly, 04 = Quarterly, 06 = Semi-annually, 12 = Annually, 99 = Irregular.",
```

This automatically becomes the native `title` tooltip on the header `<th>`
via `sortHeader()` (`index.html:2429-2443`), which already reads
`getHeaderTooltip(header)` for every column — no changes needed to
`sortHeader()` itself.

#### Step 1.5 — sorting works with zero extra code

`isNumericColumn()` (`index.html:2485`) checks whether **every** value in a
column matches `sortableNumber()`'s pure-numeric regex
(`index.html:2539-2550`). A value like `"01 - Monthly"` fails that regex, so
`isNumericColumn("Frequency")` will correctly return `false`, and
`compareSortableValues()` (`index.html:2520-2537`) will fall back to
`localeCompare(..., { numeric: true })`. Because every code is a
zero-padded two-digit prefix, this already sorts `"00 - ..."` < `"01 -
..."` < `"04 - ..."` < `"06 - ..."` < `"12 - ..."` < `"99 - ..."` correctly
in both directions. **Do not add a special case to `isNumericColumn` or
`sortableNumber`** — the existing generic string-compare path handles this
column correctly as-is, exactly the way `Type` or `Ticker` already do.

#### Step 1.6 — CSV/TXT export parity is automatic

`generateFileContent()` (`index.html:2580-2629`) builds the CSV for the ETF
Catalog sheet generically from `currentSheet.headers` and `currentSheet.data`
(`staticCatalogSheet.headers`/`.data`), and the TXT export
(`index.html:2656-2675`) reuses `generateFileContent()` for any
non-Watchlist sheet. Once step 1.3 adds `"Frequency"` to
`staticCatalogSheet.headers` and each row's data, **both exports pick it up
automatically in the same position as the visible column** — no separate
export-header list to update for the catalog (unlike the Watchlist sheet,
which does hardcode its own header list at `index.html:2333` and
`index.html:2583`, but that list is unrelated to the catalog column added
here).

#### Step 1.7 — the raw Distributions detail tab is unaffected

The existing per-fund **Distributions** tab (`index.html:1925-1926`,
rendered generically through `renderTable()` off
`activeFundSheets["Distributions"]`) keeps showing the provider's raw
per-payment rows (`Record Date`, `Ex-Date`, `Payable Date`, `Total
Distribution`, `Income`, `ST Cap Gains`, `LT Cap Gains`, `Return of
Capital`) untouched. No changes needed there — this satisfies "the
detail/distributions view may continue to show the provider's raw
label/data; the coded value is required only for the sortable catalog
column and exports."

## 2. Horizontally pinned catalog columns

### Current state: no pinning exists in any form

Searched `index.html` for `sticky`, `pinned`, and `#table-scroll`. The only
existing `sticky` usage is the generic sticky **header row** on `<thead>`
(`index.html:420`, `class="... sticky top-0 z-20 backdrop-blur"`), which
keeps the whole header row pinned while scrolling vertically. There is
**no** horizontal column pinning anywhere — no `.catalog-sticky-*` classes,
no per-cell `position: sticky`, nothing scoped or unscoped. This is a
from-scratch addition, not a fix.

### Real column identity, order, and widths to use

The catalog row markup is built in `renderTable()`
(`index.html:2166-2318`). The relevant cells, in row order, are:

1. `#` row-index cell — **not** pinned, per spec. Header:
   `index.html:2187-2189` (`class="py-3.5 px-4 w-12 text-center"`, `w-12` =
   3rem). Body: `index.html:2237-2239` (`class="py-2.5 px-4 text-slate-400
   dark:text-slate-500 text-xs text-center font-mono"`, no explicit width
   today).
2. **Use** column (checkbox + blacklist button) — **pin this one**. Header:
   `index.html:2193-2202` (`class="py-3.5 px-4 w-20 text-center"` — `w-20` =
   5rem — containing the `#select-all-checkbox` input). Body:
   `index.html:2243-2258` (`class="py-2.5 px-4 text-center"` containing
   `input[data-checkbox]` and `button[data-blacklist]`).
3. **Ticker** column — **pin this one**. It is not a separate hardcoded
   block; it's the first entry of the generic `headers.map(...)` loop,
   singled out by `index === 0 && currentSheet?.tickerCol` (the catalog
   sheet sets `tickerCol: "Ticker"` at `index.html:1446`). Header: rendered
   generically by `sortHeader()` (`index.html:2429-2443`) with **no width
   class today**. Body: `index.html:2266-2269` (catalog case: `class="py-2.5
   px-4 font-mono font-semibold text-blue-600 dark:text-blue-400"`, wraps
   the ticker in an `<a data-fund-view>` — again no explicit width today).
4. All remaining columns (`Fund Name`, `Type`, `NAV`, ... `Frequency` after
   step 1, etc.) scroll normally and must not be touched by this feature.

So: **pinned order is `Use` (`left: 0`) then `Ticker` (`left:` = Use's
width), exactly matching the generic spec**, with `#` correctly excluded.
Since the Ticker header/body cells have no explicit width today, this
feature must **add** one (a fixed `min-width`/`width` is required for the
sticky `left` offset math to stay correct) — pick `6rem`, which comfortably
fits this feed's tickers (up to 5 characters, e.g. `AAXJ`, `IBIJ`) in the
existing `font-mono font-semibold` styling with room to spare.

### Step 2.1 — CSS block (paste into the main `<style>` block, e.g. right after the existing `.selected-row` rules around `index.html:113-118`)

The dark-mode colors below are **pre-blended, opaque** equivalents of this
repo's actual translucent tokens, computed against this repo's real
backgrounds (not copied from another repo):

- Table container: `bg-white dark:bg-slate-800/50` (`index.html:411`) over
  the app's dark page background `#020617` (set in the anti-FOUC script,
  `index.html:39-44`) → light default is already opaque `#ffffff`; dark
  default composite (50% `#1e293b` over `#020617`) ≈ **`#101829`**.
- Row hover: `hover:bg-slate-50 dark:hover:bg-slate-700/30`
  (`index.html:2234`) → light hover is already opaque `#f8fafc`; dark hover
  (30% `#334155` over the `#101829` base above) ≈ **`#1b2436`**.
- Row selected: `.selected-row` (`index.html:113-118`) is `#eff6ff` in light
  (already opaque) and `rgba(30,64,175,.22)` in dark → composited over the
  `#101829` base ≈ **`#132046`**.
- Sticky header background: `<thead>` is `bg-slate-50
  dark:bg-slate-900/95` (`index.html:420`) → light is already opaque
  `#f8fafc`; dark (95% `#0f172a` over `#020617`) ≈ **`#0e1629`**.

```css
/* Horizontally pinned catalog columns (Use + Ticker). Scoped to
   .catalog-sticky-col so the Watchlist table and per-fund detail sheets
   (Holdings/Historical/Performance/Distributions), which reuse the same
   #table-scroll/table markup, are completely unaffected. */
#table-scroll table {
  min-width: max-content;
  border-collapse: separate; /* overrides the table's own Tailwind
                                 `border-collapse` utility class — this rule
                                 wins on specificity (id + element beats a
                                 single class), so no markup change needed */
  border-spacing: 0;
  isolation: isolate;
}
#table-scroll tbody {
  position: relative;
  z-index: 0;
}
#table-scroll tbody tr {
  position: relative;
  z-index: 0;
}
#table-scroll .catalog-sticky-col {
  position: sticky;
  background: #fff;
  background-clip: padding-box;
}
#table-scroll thead .catalog-sticky-col {
  top: 0;
  z-index: 30;
  background: #f8fafc;
}
#table-scroll tbody .catalog-sticky-col {
  z-index: 20;
}
#table-scroll .catalog-sticky-use {
  left: 0;
  width: 5rem;
  min-width: 5rem;
}
#table-scroll .catalog-sticky-ticker {
  left: 5rem;
  width: 6rem;
  min-width: 6rem;
  box-shadow: 4px 0 6px -6px rgba(15, 23, 42, 0.7);
}
.dark #table-scroll .catalog-sticky-col {
  background: #101829;
}
.dark #table-scroll thead .catalog-sticky-col {
  background: #0e1629;
}
#table-scroll tbody tr:hover .catalog-sticky-col {
  background: #f8fafc;
}
#table-scroll tbody tr.selected-row .catalog-sticky-col {
  background: #eff6ff;
}
.dark #table-scroll tbody tr:hover .catalog-sticky-col {
  background: #1b2436;
}
.dark #table-scroll tbody tr.selected-row .catalog-sticky-col {
  background: #132046;
}
```

Note the `border-collapse` comment above: the `<table>` element already
carries Tailwind's `border-collapse` utility class in its markup
(`index.html:417`, `class="w-full text-left border-collapse
whitespace-nowrap"`), which sets `border-collapse: collapse`. The rule
`#table-scroll table { border-collapse: separate; ... }` has higher CSS
specificity (an id + element selector beats a single class selector), so it
overrides that utility automatically — but call this out during review so
nobody "fixes" the apparent conflict by deleting the new CSS rule.

### Step 2.2 — apply the sticky classes directly to the `<th>`/`<td>` cells (no wrapper elements)

This is the exact defect a prior pass shipped in the SPDR sibling repo:
sticky positioning was applied to a wrapper `<span>`/`<div>` nested inside
an ordinary static `<td>`. A sticky element can never escape its containing
block, so once the static parent `<td>` scrolled out of view, the "sticky"
wrapper inside it vanished too — invisible near `scrollLeft = 0`, broken
once you actually scroll right. **Put the sticky classes on the `<th>`/
`<td>` element itself.**

**Use header** (`index.html:2193-2202`) — add `catalog-sticky-col
catalog-sticky-use` to the existing classes:

```js
? `
  <th class="catalog-sticky-col catalog-sticky-use py-3.5 px-4 w-20 text-center" title="${escapeHtml(
    getHeaderTooltip("Use"),
  )}">
    <div class="inline-flex items-center justify-center gap-1">
      <input type="checkbox" id="select-all-checkbox" ${
        allSelected ? "checked" : ""
      } class="w-4 h-4 accent-blue-600 cursor-pointer" title="Select / Deselect all ETFs" />
      <span>Use</span>
    </div>
  </th>
`
```

**Use body cell** (`index.html:2243-2258`):

```js
<td class="catalog-sticky-col catalog-sticky-use py-2.5 px-4 text-center">
  <div class="inline-flex items-center justify-center gap-1.5">
    <input data-checkbox="${escapeHtml(item.Ticker)}" type="checkbox" ${
      isSelected ? "checked" : ""
    } class="w-4 h-4 accent-blue-600 cursor-pointer" aria-label="Use ${escapeHtml(
      item.Ticker,
    )}" />
    <button data-blacklist="${escapeHtml(item.Ticker)}" class="w-4 h-4 rounded text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 leading-none transition" title="Blacklist ${escapeHtml(
      item.Ticker,
    )} — hide it from All ETFs">✕</button>
  </div>
</td>
```

**Ticker header**: the Ticker `<th>` is produced generically by
`sortHeader()` (`index.html:2429-2443`), invoked from the shared
`headers.map((header) => sortHeader(header)).join("")` at `index.html:2206`
— that call site is used for **every** sheet (catalog, and every per-fund
detail sheet), so `sortHeader()` itself must not unconditionally pin
column 0. Give `sortHeader()` an optional pin flag, and only pass it `true`
for the catalog's first header:

```js
function sortHeader(header, pinnedClass = "") {
  const active = sortKey === header;
  const arrow = active ? (sortDir === "asc" ? " ↑" : " ↓") : "";
  const tooltip = getHeaderTooltip(header);
  const isNumeric = isNumericColumn(header);
  const align = isNumeric ? " text-right" : "";

  return `<th class="${pinnedClass}py-3.5 px-4${align}" title="${escapeHtml(
    tooltip,
  )}"><button data-sort="${escapeHtml(header)}" title="${escapeHtml(
    tooltip,
  )}" class="uppercase tracking-wider hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:text-blue-600 dark:focus:text-blue-400">${escapeHtml(
    header,
  )}${arrow}</button></th>`;
}
```

And at the call site (`index.html:2206`), pin only the catalog's ticker
header (index 0, when `isCatalog` is true):

```js
${headers
  .map((header, index) =>
    sortHeader(
      header,
      isCatalog && index === 0
        ? "catalog-sticky-col catalog-sticky-ticker "
        : "",
    ),
  )
  .join("")}
```

(Keep the trailing space in the pinned-class string so it doesn't run into
`py-3.5` when concatenated.) This also automatically keeps the Watchlist
table and the per-fund detail sheets un-pinned, since they call
`sortHeader(header)` with no second argument (Watchlist's own header list at
`index.html:2333`/`:2352` is unaffected; unrelated fund-detail calls at
`index.html:2446` for sort binding don't call `sortHeader` at all).

**Ticker body cell** — in the `headers.map(...)` body loop
(`index.html:2262-2274`), the catalog-ticker branch is:

```js
if (index === 0 && currentSheet?.tickerCol) {
  if (isCatalog) {
    return `<td class="catalog-sticky-col catalog-sticky-ticker py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400"><a href="javascript:void(0)" class="hover:underline" data-fund-view="${escapeHtml(
      value,
    )}">${escapeHtml(value)}</a></td>`;
  }
  return `<td class="py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400">${escapeHtml(
    value,
  )}</td>`;
}
```

(Only the `isCatalog` branch gets the sticky classes — the non-catalog
branch, used by per-fund detail sheets whose first column is also
`tickerCol`-like, e.g. Holdings, is intentionally left alone.)

### Step 2.3 — verify by actually scrolling

Per the generic spec, this class of bug is invisible near `scrollLeft = 0`
and only shows up once you scroll all the way right. After implementing,
open the app (serve the repo root as a static site or open `index.html`
directly), load the catalog, and:

1. Scroll the table horizontally to the far right — confirm the `Use`
   checkbox column and `Ticker` column stay pinned in place while every
   other column (including `#`) scrolls away underneath them.
2. Confirm `#` is **not** pinned — it must scroll off to the left with the
   rest of the row.
3. With the table scrolled right, click a checkbox and the blacklist `✕`
   button in the pinned `Use` column — both must remain clickable.
4. Hover a row, and separately select a row (click it to toggle selection),
   while scrolled right — confirm the pinned cells show a fully opaque
   background matching the row's hover/selected state, with no bleed-through
   of the columns scrolling underneath, in both light and dark theme (use
   the theme toggle already in the header).
5. Scroll vertically too (with many rows loaded) while scrolled
   horizontally, and confirm the sticky header row still renders above the
   pinned body cells (no z-index inversion).
6. Switch to the Watchlist tab and to a fund's Holdings/Historical/
   Performance/Distributions detail tabs — confirm none of these tables
   show pinned columns (they must render exactly as before; nothing in
   this feature should reach them, since `.catalog-sticky-col` is only ever
   emitted for the ETF Catalog sheet).

Automated verification (headless browser) is preferable to eyeballing a
screenshot at `scrollLeft = 0`, since that is exactly what let the SPDR
regression ship unnoticed.

## Acceptance checklist

Distribution frequency column:

- [ ] `deriveDistributionFrequency()` added to `scripts/update-data.ts` and
      exported, with unit tests in `scripts/update-data.test.ts`.
- [ ] `updateFund()` computes `distributionFrequency` from the fund's own
      `Distributions` worksheet (already downloaded) and adds it to
      `indexFields`, without deleting the `Distributions` worksheet from
      `document.worksheets`.
- [ ] After `bun run update`, `api/ishares/index.json` fund entries carry a
      `distributionFrequency` field shaped like `"01 - Monthly"`.
- [ ] `staticCatalogSheet.headers` in `index.html` has `"Frequency"` between
      `"SEC Yield"` and `"YTD Return"`.
- [ ] `staticCatalogSheet.data` row objects set `Frequency:
      fund.distributionFrequency || "00 - Unknown"` in the same position.
- [ ] `COLUMN_TOOLTIPS.Frequency` explains the source (the fund's own
      Distributions history) and the numeric codes.
- [ ] Catalog column sorts ascending/descending correctly by code (00 → 01
      → 04 → 06 → 12 → 99) with no changes to `isNumericColumn`/
      `sortableNumber`.
- [ ] CSV and TXT exports of the ETF Catalog sheet include `Frequency` in
      the same position as the visible column, with no separate export code
      path to update.
- [ ] The per-fund Distributions detail tab is unchanged and still shows
      raw per-payment rows.

Horizontally pinned catalog columns:

- [ ] `#table-scroll` remains the only horizontal scroll surface; the page
      itself does not scroll horizontally.
- [ ] Only `Use` and `Ticker` are pinned; `#` and every other column scroll
      normally.
- [ ] Sticky classes (`catalog-sticky-col`, `catalog-sticky-use`,
      `catalog-sticky-ticker`) are applied directly to the `<th>`/`<td>`
      elements, never to a nested wrapper.
- [ ] `catalog-sticky-use` is `left: 0; width/min-width: 5rem`;
      `catalog-sticky-ticker` is `left: 5rem; width/min-width: 6rem` with the
      right-edge box-shadow.
- [ ] Sticky header cells use `z-index: 30`; sticky body cells use
      `z-index: 20`; `tbody`/`tr` have `position: relative; z-index: 0`; the
      table has `border-collapse: separate; border-spacing: 0; isolation:
      isolate`.
- [ ] Every pinned-cell background (default, hover, selected; light and
      dark) is a solid opaque color — verified against this repo's real
      `#ffffff` / `#101829` / `#f8fafc` / `#1b2436` / `#eff6ff` / `#132046`
      / `#0e1629` values, not a reused translucent `rgba(...)`.
- [ ] Pinning is scoped to the `.catalog-sticky-*` classes only — the
      Watchlist table and per-fund detail sheets (which share
      `#table-scroll`) render with zero pinned columns, unchanged.
- [ ] Checkbox and blacklist button in the pinned `Use` cell remain
      clickable after scrolling horizontally.
- [ ] Verified by actually scrolling the table fully to the right in a real
      or headless browser — not just by reading the CSS or looking at an
      unscrolled screenshot.
- [ ] Existing responsive table sizing (`fitTableScrollHeight`), lazy
      loading, search, sorting, row selection, and dark theme all still work.

## Handoff summary

iShares keeps everything in one `index.html` with no real build step (the
`.parcel-cache`/`dist` artifacts are dead and gitignored) — every catalog
change is a direct edit to that file. Feature 1 needs a small pipeline
addition in `scripts/update-data.ts` (`deriveDistributionFrequency()`,
called from `updateFund()`, feeding a new `distributionFrequency` field into
`indexFields`/`index.json`) because iShares' raw feed only exposes
individual distribution-payment rows, not a ready-made frequency label — the
client then just reads `fund.distributionFrequency` and places it between
the real `SEC Yield` and `YTD Return` columns, with sorting and CSV/TXT
export working for free off the existing generic code paths. Feature 2 is a
from-scratch addition (no pinning exists in the repo today): pin exactly
`Use` (`left: 0`, 5rem) and `Ticker` (`left: 5rem`, 6rem, needs its
first-ever explicit width) directly on their `<th>`/`<td>` cells via a
`.catalog-sticky-col` class family, using this repo's own pre-blended solid
colors for `#ffffff`/`#101829` (default), `#f8fafc`/`#1b2436` (hover), and
`#eff6ff`/`#132046` (selected), scoped so the shared `#table-scroll` table
used by the Watchlist and per-fund detail tabs is left untouched — and it
must be verified by actually scrolling all the way right, not just by
reading the CSS.
