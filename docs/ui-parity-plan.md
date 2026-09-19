# iShares — UI parity plan

Full rationale, exact CSS values, and pitfall catalog: read
`/tmp/etf-ui-parity-plan.md` (master plan) in full before starting, especially
its §1.2 ("iShares specifically"). This document is the iShares-specific
action list. iShares' own `docs/catalog-ui-requirements.md` already has the
most complete/correct sticky-column spec of the four target repos (including
this repo's own dark-mode colors, already computed against its different page
background) — read it, follow it for the CSS, adapt the JS per §2 below.

## 0. Structural differences — read before touching anything

iShares is the outlier of the four target repos:

- **No JSON feed / `scripts/update-data.ts`.** Data comes from a
  user-uploaded Excel (SpreadsheetML) file parsed client-side into an
  IndexedDB (`iSharesWatchlistDB`). There is no `api/ishares/*.json`.
- **One shared generic `renderTable(data, headers)`** renders every sheet
  (catalog, Watchlist, everything) via inline `isCatalog`-style ternaries,
  instead of separate `renderFundsTable()`/`renderWatchlistTable()` functions
  like the other three repos.
- **`sortHeader(header)` takes one positional argument**, no `extraClass`
  parameter yet.
- **Page background is `#020617` (`slate-950`)**, not `#0f172a` — every
  dark-mode color in the other repos' plans is computed against the wrong
  base for this repo; do not paste those hex values here.
- There's a `dist/index.html` in the repo. Determine whether it's a checked-in
  build artifact that needs regenerating after your changes (check for a
  build script in `package.json`) or a stale/ignorable file, and say which in
  your PR/commit description.

## 1. Frequency catalog column — investigate before implementing

There is no dividend/distribution-cadence field anywhere in the current data
model (no JSON feed to source it from). **Before writing any code**, check
whether the uploaded Excel format iShares parses actually contains a
distribution-frequency column at all (inspect the parsing code and, if
possible, a real sample file). If it's genuinely absent, **skip this feature
entirely and say so explicitly** in your PR/report — do not fabricate a
column with placeholder or guessed data.

## 2. Pinned catalog Use+Ticker columns + pinned Watchlist Ticker column

Follow `docs/catalog-ui-requirements.md` for the CSS (already correct,
including the `#020617`-based dark colors — do not substitute the other
repos' `#172033`/`#1f2a3d`/`#19274e` values, they're wrong for this repo's
color stack; per master plan §1.2/§4.3 the correct iShares-specific values
are approximately base `#101829`, hover `#1b2436`, selected `#132046`, header
`#0e1629` — verify these against the doc's own numbers and use whichever is
authoritative there).

For the JS/markup side, adapt to this repo's shape (master plan §1.2):

1. Add an optional trailing `extraClass = ''` parameter to `sortHeader()`:
   ```ts
   function sortHeader(header: string, extraClass = ''): string {
     // ...existing logic, append extraClass to the <th> class list
   }
   ```
2. In the shared `renderTable()`'s header-building code, pass
   `'catalog-sticky-col catalog-sticky-ticker'` only for the Ticker header
   inside the `isCatalog` branch — every other call site (every other sheet)
   passes nothing and is unaffected.
3. Find the inline Use `<th>`/`<td>` ternary branches (conditioned on
   `isCatalog`) and add `catalog-sticky-col catalog-sticky-use` to their
   class lists directly — sticky positioning goes on the `<th>`/`<td>`
   itself, never a wrapper `<span>`/`<div>` nested inside it (master plan §2,
   this exact mistake cost SPDR 3 wrong attempts before they fixed it).
4. Repeat the same pattern for the Watchlist table's Ticker column/header
   inside `renderTable()`'s Watchlist branch, using
   `.watchlist-sticky-ticker` (or the two-class split).
5. `#table-scroll` is shared by every sheet `renderTable()` renders — make
   absolutely sure the sticky classes are only ever added inside the
   `isCatalog`/Watchlist-specific branches, never globally, or every other
   sheet silently inherits pinned columns it shouldn't have (master plan
   §2.1 — SPDR's very first, worst mistake).

## 3. Shared UI contract — adapt, don't port literally

Read `/Users/maksim.kostromin/Documents/code/private/WisdomTree/docs/ui-contract.md`
as the mechanism spec, then adapt with these iShares-specific judgment calls
already made for you:

- **Per-tab filter/sort persistence, selection scopes**: port directly, same
  concepts apply regardless of data source (state shape, localStorage keys,
  `.every()`-based select-all checked state, the three distinct selection
  scopes per master plan §5.4).
- **Race-free Watchlist aggregation (master plan §5.5)**: the original
  mechanism exists to fix a race between overlapping *async, paginated*
  per-fund fetches. iShares' data arrives synchronously from a single parsed
  upload — there is no per-fund async fetch to race. **Conclusion: the
  serialized-load-chain mechanism does not apply here as originally
  described; skip implementing it.** What *does* still apply: Watchlist
  aggregation must still be recomputed reactively and correctly every time
  selection changes (toggle, header select-all, "All ETFs" pill, blacklist
  removal, Clear, page-load restore) — verify this reactivity exists and
  fix it if any selection-change path fails to refresh the Watchlist.
- **Chunked rendering (master plan §5.7)**: still applicable if a large
  Watchlist can be rendered from a big uploaded file — verify whether large
  DOM insertions are already chunked; if not, add fixed-size chunked
  rendering (e.g. 250-500 rows) with a "load more" sentinel, same as the
  other repos.
- **Dedup fallback order (master plan §5.8)**: applies unchanged — port the
  ticker→CUSIP→ISIN→Identifier→SEDOL/FIGI→name fallback chain with
  placeholder detection, adapted to whatever field names the Excel parser
  produces.

## 4. Blacklist panel smooth expand/collapse

This ports directly, no adaptation needed. Per repo audit, iShares has a code
comment claiming an existing "Selected ETF Detail & Watchlist Navigation
Panel (Animated expand/collapse)" — find and confirm its actual class/CSS
first (verify the comment matches real behavior), then apply the exact same
transition shape to `#blacklist-panel` per master plan §6: CSS max-height/
opacity/transform/padding/border-color transition, JS-measured `scrollHeight`
(unbounded chip list), remove `hidden` utility class, `p-4`→`px-4`, swap the
JS toggle (currently `blacklistPanel.classList.toggle("hidden")`) to
`classList.toggle('is-visible')` + a `syncBlacklistPanelHeight()` helper.

## 5. Implementation order

Investigate Frequency-column feasibility (§1, skip if not feasible) → sticky
columns (§2) → shared UI contract (§3, largest piece) → blacklist animation
(§4, independent, any time).

## 6. Verification checklist

- Run whatever test suite exists.
- Real/headless browser: upload a sample Excel file, scroll catalog and
  Watchlist tables fully right in both light and dark theme — pinned columns
  stay opaque, no bleed-through, header cell matches header row color.
- Confirm no other sheet (Holdings/History/Overview/whatever else
  `renderTable()` renders) accidentally got pinned columns.
- Switch tabs with different search queries and sorts, reload, confirm both
  are independently remembered per tab.
- Exercise all three selection scopes.
- Open/close the Blacklist panel — animates smoothly; add/remove a
  blacklisted ticker while open — panel resizes smoothly.
- If `dist/index.html` is a real build artifact, regenerate it; if stale,
  note that in your report rather than silently leaving it out of sync.
