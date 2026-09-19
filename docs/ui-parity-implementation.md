# UI parity implementation notes

## Scope and decisions

Implemented `docs/ui-parity-plan.md` in its requested order, using the user's
corrections for the primary static API, interval-derived Frequency, and async
Watchlist loading. The external master plan and WisdomTree mechanism document
were unavailable; the repository specifications plus those corrections are the
authoritative sources. No requested feature was skipped.

- **Frequency:** `distributions.frequencyCode` in both fund metadata and catalog
  summaries. Derived offline from existing Distributions worksheets and on future
  updater runs. Uses distinct Ex-Date observations (Payable Date fallback), the
  latest 13 events, at least three observations, and a median interval supported
  by at least 80% of intervals. Day windows are 20–40, 70–110, 150–215, and
  330–400 for monthly/quarterly/semiannual/annual respectively. These conservative
  inference thresholds are assumptions, not an issuer-promised schedule.
  Insufficient history is `00 - —`; ambiguous history is `99 - Irregular`.
  Raw distribution rows, holdings, history, and all other metadata are unchanged
  by the backfill. Catalog column order, tooltip, dynamic empty-state colspan,
  CSV and TXT include Frequency; no detail-table Frequency column was added.
- **Pinned cells:** catalog Use at 0/5rem and Ticker at 5rem/6rem; Watchlist
  Ticker at 0/6rem. Classes are on the cells, never wrappers. The exact specified
  opaque light/dark colors, stacking levels, separate borders and isolation are
  retained. The body had actually used slate-900 despite the HTML anti-FOUC
  background being slate-950; it now uses slate-950 so the documented dark color
  stack is consistent. Other sheets have no pinned columns.
- **Preferences:** versioned `ishares-site-state` stores query/sort per sheet,
  separated between static and uploaded modes. Detail preferences intentionally
  follow the sheet across funds; uploaded preferences follow the sheet across
  files. Legacy global preferences migrate to Catalog only.
- **Selection:** row toggles one fund; header toggles filtered/rendered catalog
  rows; All ETFs toggles the entire non-blacklisted catalog without navigating.
  ETF Catalog is a separate navigation button. Checked states use `.every()`.
- **Watchlist:** one serialized chain per ticker is shared by detail and
  background holdings loads. Page state is read inside the chain; a six-slot
  limiter bounds parallel loads. Cache completion cannot re-select funds or
  aggregate a deselected fund. Counts show Loading…, N+, and the final deduped
  count. Failed loads offer Retry. Chunk size is 250; later chunks append via
  the sentinel/scrolling. Background refresh of an expanded view is also split
  over animation frames. Copy/CSV/TXT use the complete filtered, sorted result.
- **Dedup:** namespaced ticker → CUSIP → ISIN → Identifier/Security-ID →
  SEDOL/FIGI → published name. Placeholder detection continues down the chain;
  numeric tickers, bonds, derivatives and cash are not blanket-filtered out.
  The Ticker display/export field contains the published fallback identifier or
  name when no usable ticker exists; long identities have a full-value tooltip.
- **Blacklist:** uses the existing detail-panel transition shape, measured
  content height, no `hidden` utility, closed-panel `inert`, ARIA state, and
  reduced-motion support. Explicit height also transitions so removing chips
  animates rather than snapping to intrinsic content height. Resize observers
  keep panel sizing and the table's viewport budget in sync.

## Existing data limitation found during investigation

Some already-published bond holdings pages (for example AGG) have headers such
as `Inception Date` rather than security headers: the earlier parser selected
introductory metadata when no Ticker column existed. The parser now recognizes
security-name/identifier headers with holdings metrics, including for uploads.
However, identifiers already discarded in those JSON pages cannot be recovered
from that JSON. A normal provider-data update is still needed to repair them.
The offline Frequency migration intentionally does not invent or rewrite these
holdings. Rows with no published security identity at any fallback tier cannot
be meaningfully deduplicated as securities.

## Build and data artifacts

This is still a static, no-build `index.html`. `dist/` is gitignored, has no
tracked files, and has no supporting build script; it was not regenerated.
The only data changes are the small Frequency fields in 480 existing metadata
files and the catalog, not new downloaded datasets. Reproduce the offline
backfill with:

```sh
bun scripts/backfill-frequency.ts
```

## Verification

```sh
bun run test
# 15 pass, 0 fail, 61 expect() calls

# In a separate terminal:
python3 -m http.server 8000 --bind 0.0.0.0
# One-time browser install:
bunx playwright install chromium
bun run test:ui
```

The browser suite exercises an eight-fund, three-pages-per-fund fixture (4,809
unique securities) and the real 480-fund catalog / IVV holdings. Checks include
all selection scopes, overlapping detail/background requests (no duplicate
metadata/holdings requests, peak at most six), deselection in flight, fallback
identity collisions, Loading/N+/final counts, 250-row chunks and full filtered
exports, query/sort restoration across four tabs and reloads, SpreadsheetML
upload, and unpinned detail sheets. Catalog and Watchlist were scrolled fully
right in both themes; screenshots were inspected and computed opaque colors,
cell positions, hover/selected colors, and vertical header stacking asserted.
Wrapped blacklist chips were tested for smooth growth and shrink, as well as
open/close and reduced motion. No browser JavaScript errors occurred.

The sandbox blocks the Tailwind CDN and direct browser downloads. Verification
used npm-provided headless Chromium 153 and an offline Tailwind 3.4.17 build of
this exact HTML, intercepted **only in the test browser**. The application CDN
setup was not changed. `test:ui` optionally accepts `CHROMIUM_PATH`,
`UI_TEST_CSS`, `UI_SCREENSHOTS`, and `BASE_URL` for such environments.

A structural comparison against Git HEAD verified that all 480 metadata files
and the catalog are unchanged apart from `distributions.frequencyCode`.
