// npm/bun install; playwright install chromium; bun run test:ui
// Optional: BASE_URL, CHROMIUM_PATH, UI_TEST_CSS (offline Tailwind v3 build), UI_SCREENSHOTS.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const baseURL = process.env.BASE_URL || "http://127.0.0.1:8000";
const errors = [];
async function newPage() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  if (process.env.UI_TEST_CSS) {
    const css = await readFile(process.env.UI_TEST_CSS, "utf8");
    await context.route("https://cdn.tailwindcss.com/**", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `window.tailwind={};const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);`,
      }),
    );
    await context.route("https://fonts.googleapis.com/**", (route) =>
      route.fulfill({ body: "" }),
    );
  }
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
}
async function shot(page, name) {
  if (!process.env.UI_SCREENSHOTS) return;
  await mkdir(process.env.UI_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.UI_SCREENSHOTS}/${name}.png` });
}
const tickers = Array.from({ length: 8 }, (_, i) => `T0${i + 1}`);
const shared = [
  { Ticker: "COMMON", Name: "Shared equity" },
  { Ticker: "--", CUSIP: "BOND1", Name: "Bond security" },
  { Ticker: "N/A", ISIN: "US1", Name: "International bond" },
  { Ticker: "NA", "Security-ID": "ID1", Name: "Derivative" },
  { Ticker: "NONE", SEDOL: "SED1", Name: "SEDOL security" },
  { Ticker: "NULL", FIGI: "FIG1", Name: "FIGI security" },
  { Ticker: "—", Name: "Cash reserve", "Asset Class": "Cash" },
  { Ticker: "SAME", Name: "Ticker SAME" },
  { Ticker: "", CUSIP: "SAME", Name: "CUSIP SAME" },
];
let concurrent = 0,
  peak = 0;
const requests = new Map();
async function fixtures(page) {
  await page.route("**/api/ishares/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.set(path, (requests.get(path) || 0) + 1);
    if (path.endsWith("/index.json"))
      return route.fulfill({
        json: {
          funds: tickers.map((ticker, i) => ({
            ticker,
            name: `Fixture${i + 1} ETF`,
            holdings: 609,
            history: 1,
            distributions: { frequencyCode: "04 - Quarterly" },
          })),
        },
      });
    const ticker = path.split("/")[4];
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) =>
      setTimeout(resolve, path.includes("holdings/002") ? 300 : 60),
    );
    let json;
    if (path.endsWith("meta.json"))
      json = {
        holdings: {
          pages: [
            "./holdings/001.json",
            "./holdings/002.json",
            "./holdings/003.json",
          ],
        },
        history: { pages: ["./history/001.json"] },
        worksheets: {
          Performance: {
            headers: ["Date", "Value"],
            rows: [{ Date: "2026-01-01", Value: "100" }],
          },
          Distributions: {
            headers: ["Ex-Date", "Total Distribution"],
            rows: [{ "Ex-Date": "2026-01-02", "Total Distribution": "1" }],
          },
        },
      };
    else if (path.includes("history/"))
      json = {
        headers: ["As Of", "NAV per Share"],
        rows: [{ "As Of": "2026-01-01", "NAV per Share": "100" }],
      };
    else {
      const n = Number(path.match(/(\d+)\.json$/)[1]);
      json = {
        headers: ["Ticker", "Name", "Weight (%)", "Market Value"],
        rows: [
          ...Array.from({ length: 200 }, (_, i) => ({
            Ticker: `${ticker}_${(n - 1) * 200 + i}`,
            Name: `${ticker} security ${i}`,
            "Weight (%)": "1",
            "Market Value": "100",
          })),
          ...(n === 1 ? shared : []),
        ],
      };
    }
    concurrent--;
    await route.fulfill({ json });
  });
}
async function stickyCheck(page, theme, watchlist = false) {
  if (
    ((await page.locator("html").getAttribute("class")) || "").includes(
      "dark",
    ) !==
    (theme === "dark")
  )
    await page.click("#theme-toggle");
  await page.locator("#table-scroll").evaluate((el) => {
    el.scrollTop = 0;
    el.scrollLeft = el.scrollWidth;
  });
  await page.mouse.move(10, 10);
  await page.waitForTimeout(400);
  const result = await page.evaluate((watchlist) => {
    const wrap = document
      .getElementById("table-scroll")
      .getBoundingClientRect();
    const cls = watchlist ? ".watchlist-sticky-ticker" : ".catalog-sticky-col";
    const read = (el) => ({
      tag: el.tagName,
      left: el.getBoundingClientRect().left - wrap.left,
      bg: getComputedStyle(el).backgroundColor,
      position: getComputedStyle(el).position,
      z: getComputedStyle(el).zIndex,
    });
    return {
      heads: [...document.querySelectorAll(`#table-head ${cls}`)].map(read),
      cells: [
        ...document.querySelectorAll(`#table-body tr:first-child ${cls}`),
      ].map(read),
      indexLeft:
        document
          .querySelector("#table-body tr:first-child td")
          .getBoundingClientRect().left - wrap.left,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  }, watchlist);
  assert.equal(result.cells.length, watchlist ? 1 : 2);
  assert.equal(result.pageOverflow, false);
  assert.ok(result.indexLeft < 0, "row index must scroll away");
  result.cells.forEach((cell, i) => {
    assert.equal(cell.tag, "TD");
    assert.equal(cell.position, "sticky");
    assert.ok(Math.abs(cell.left - i * 80) <= 1, JSON.stringify(result));
    assert.equal(cell.z, "20");
    assert.ok(!cell.bg.startsWith("rgba"));
  });
  result.heads.forEach((cell) => {
    assert.equal(cell.tag, "TH");
    assert.equal(cell.z, "30");
    assert.equal(
      cell.bg,
      theme === "dark" ? "rgb(14, 22, 41)" : "rgb(248, 250, 252)",
    );
  });
  await shot(page, `${watchlist ? "watchlist" : "catalog"}-${theme}-right`);
  // Hover has an opaque matching color; selected rows retain their selected color.
  await page
    .locator(
      `#table-body tr:first-child ${watchlist ? ".watchlist-sticky-ticker" : ".catalog-sticky-use"}`,
    )
    .hover();
  const bg = await page
    .locator(
      `#table-body tr:first-child ${watchlist ? ".watchlist-sticky-ticker" : ".catalog-sticky-use"}`,
    )
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const selected =
    !watchlist &&
    (await page
      .locator("#table-body tr:first-child")
      .evaluate((el) => el.classList.contains("selected-row")));
  assert.equal(
    bg,
    theme === "dark"
      ? selected
        ? "rgb(19, 32, 70)"
        : "rgb(27, 36, 54)"
      : selected
        ? "rgb(239, 246, 255)"
        : "rgb(248, 250, 252)",
  );
  // Vertical header remains above body cells too.
  await page.locator("#table-scroll").evaluate((el) => {
    el.scrollTop = 150;
  });
  assert.ok(
    await page.locator("#table-head").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const left = document
        .getElementById("table-scroll")
        .getBoundingClientRect().left;
      return Boolean(
        document.elementFromPoint(left + 30, r.top + 12)?.closest("thead"),
      );
    }),
  );
}
try {
  const page = await newPage();
  await fixtures(page);
  await page.goto(baseURL);
  await page.waitForSelector('input[data-checkbox="T01"]');
  assert.equal(await page.locator("input[data-checkbox]:checked").count(), 0);
  // Row selection, filtered header selection, and whole-catalog toggle remain distinct.
  await page.click('input[data-checkbox="T01"]');
  await page.waitForFunction(() =>
    document.querySelector('[data-tab="Watchlist"]').textContent.includes("+"),
  );
  await page.fill("#search-input", "Fixture2");
  assert.equal(await page.locator("#select-all-checkbox").isChecked(), false);
  await page.click("#select-all-checkbox");
  assert.deepEqual(await page.evaluate(() => [...selectedETFs].sort()), [
    "T01",
    "T02",
  ]);
  await page.click("#select-all-checkbox");
  assert.deepEqual(await page.evaluate(() => [...selectedETFs]), ["T01"]);
  await page.click('[data-sort="Fund Name"]');
  await page.click('[data-tab="Watchlist"]');
  assert.equal(await page.inputValue("#search-input"), "");
  await page.fill("#search-input", "security");
  await page.click('[data-sort="Name"]');
  await page.click("#select-all-toggle");
  assert.equal(await page.evaluate(() => activeSheetName), "ETF Catalog");
  assert.equal(await page.evaluate(() => selectedETFs.size), 8);
  await page.click('[data-tab="Watchlist"]');
  // Detail pager and background loader deliberately overlap on the same ticker.
  await page.evaluate(async () => {
    activeFundTicker = "T03";
    await Promise.all([
      loadStaticFundSheets("T03", false),
      loadNextHoldingsPage("T03"),
      ensureHoldingsForSelected(),
    ]);
  });
  await page.waitForFunction(
    () =>
      !isHoldingsLoading &&
      [...selectedETFs].every((t) => holdingsState(t).complete),
  );
  assert.ok(peak <= 6, `peak loads ${peak}`);
  assert.equal(
    await page.evaluate(() => getDedupedWatchlistRows().length),
    4809,
  );
  assert.equal(
    await page.evaluate(
      () =>
        getDedupedWatchlistRows().find((r) => r.Ticker === "COMMON")["# ETFs"],
    ),
    8,
  );
  for (const [path, count] of requests)
    if (path.includes("holdings/") || path.endsWith("meta.json"))
      assert.equal(count, 1, `duplicate fetch: ${path}`);
  assert.equal(
    await page.locator("#table-body .watchlist-sticky-ticker").count(),
    250,
  );
  const fullFiltered = await page.evaluate(
    () => getFilteredWatchlistRows().length,
  );
  assert.equal(
    await page.evaluate(() => generateFileContent().split("\n").length - 1),
    fullFiltered,
  );
  await page.click("#copy-btn");
  assert.equal(
    (await page.evaluate(() => navigator.clipboard.readText())).split(", ")
      .length,
    fullFiltered,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.click("#export-txt-btn");
  const download = await downloadPromise;
  const text = await readFile(await download.path(), "utf8");
  assert.equal(text.split("\n").length, fullFiltered);
  await page.locator("#watchlist-more-btn").click();
  assert.ok(
    (await page.locator("#table-body .watchlist-sticky-ticker").count()) >= 500,
  );
  // Each tab's query/sort survives tab switches and a reload.
  await page.click("#all-etfs-tab-btn");
  assert.equal(await page.inputValue("#search-input"), "Fixture2");
  assert.equal(await page.evaluate(() => sortKey), "Fund Name");
  await page.reload();
  await page.waitForSelector("#select-all-checkbox");
  assert.equal(await page.inputValue("#search-input"), "Fixture2");
  await page.click('[data-tab="Watchlist"]');
  assert.equal(await page.inputValue("#search-input"), "security");
  assert.equal(await page.evaluate(() => sortKey), "Name");
  await page.waitForFunction(
    () => !isHoldingsLoading && getDedupedWatchlistRows().length === 4809,
  );
  await page.fill("#search-input", "");
  await stickyCheck(page, "light", true);
  await stickyCheck(page, "dark", true);
  // The All ETFs checkbox deselects globally and returns to Catalog, even with a search.
  await page.fill("#search-input", "COMMON");
  await page.click("#select-all-toggle");
  assert.equal(await page.evaluate(() => activeSheetName), "ETF Catalog");
  assert.equal(await page.evaluate(() => getDedupedWatchlistRows().length), 0);
  await page.click("#all-etfs-tab-btn");
  await page.fill("#search-input", "");
  await stickyCheck(page, "light");
  await stickyCheck(page, "dark");
  // Select and blacklist while fully scrolled right: controls must remain hit-testable.
  await page.locator("#table-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.click('input[data-checkbox="T01"]');
  assert.equal(
    await page
      .locator('tr[data-static-ticker="T01"] .catalog-sticky-use')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(19, 32, 70)",
  );
  await page.click('button[data-blacklist="T01"]');
  assert.equal(await page.locator('input[data-checkbox="T01"]').count(), 0);
  assert.equal(await page.evaluate(() => selectedETFs.has("T01")), false);
  await page.click("#blacklist-btn");
  await page.waitForTimeout(100);
  const mid = await page
    .locator("#blacklist-panel")
    .evaluate((el) => +getComputedStyle(el).opacity);
  assert.ok(mid > 0 && mid < 1, `not animating: ${mid}`);
  await page.waitForTimeout(400);
  await page.fill("#blacklist-input", tickers.slice(1).join(", "));
  await page.click("#blacklist-add-btn");
  await page.waitForTimeout(400);
  assert.ok(
    await page
      .locator("#blacklist-panel")
      .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  );
  await page.click('button[data-unblacklist="T02"]');
  assert.equal(await page.locator('input[data-checkbox="T02"]').count(), 1);
  await shot(page, "blacklist-expanded");
  await page.click("#blacklist-clear-btn");
  await page.click("#blacklist-btn");
  await page.waitForTimeout(400);
  assert.equal(
    await page
      .locator("#blacklist-panel")
      .evaluate((el) => el.getBoundingClientRect().height),
    0,
  );
  // Details never inherit pinned columns; independent tab search/sort also persists.
  await page.locator("#table-scroll").evaluate((el) => {
    el.scrollLeft = 0;
  });
  await page.click('[data-fund-view="T02"]');
  await page.waitForFunction(() => activeSheetName === "Holdings");
  assert.equal(
    await page
      .locator(
        "#table-head .catalog-sticky-col, #table-body .watchlist-sticky-ticker",
      )
      .count(),
    0,
  );
  await page.fill("#search-input", "T02");
  await page.click('[data-sort="Name"]');
  await page.click('[data-tab="Historical"]');
  await page.fill("#search-input", "2026");
  await page.click('[data-sort="As Of"]');
  await page.click('[data-tab="Holdings"]');
  assert.equal(await page.inputValue("#search-input"), "T02");
  await page.reload();
  await page.waitForSelector('[data-sort="Name"]');
  assert.equal(await page.inputValue("#search-input"), "T02");
  await page.click('[data-tab="Historical"]');
  assert.equal(await page.inputValue("#search-input"), "2026");
  await page.click("#reset-btn");
  assert.equal(await page.evaluate(() => selectedETFs.size), 0);
  // Upload a real SpreadsheetML-shaped test workbook; preserve tickerless securities.
  const xml = `<ss:Workbook xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><ss:Worksheet ss:Name="Holdings"><ss:Table>${[
    ["Ticker", "Name", "CUSIP"],
    ["--", "Uploaded bond", "B1"],
    ["USD", "Uploaded cash", ""],
  ]
    .map(
      (row) =>
        `<ss:Row>${row.map((v) => `<ss:Cell><ss:Data ss:Type="String">${v}</ss:Data></ss:Cell>`).join("")}</ss:Row>`,
    )
    .join("")}</ss:Table></ss:Worksheet></ss:Workbook>`;
  await page.setInputFiles("#file-input", {
    name: "sample.xls",
    mimeType: "application/vnd.ms-excel",
    buffer: Buffer.from(xml),
  });
  await page.waitForFunction(
    () =>
      isUploadedFile &&
      workbookSheets.Holdings?.data.length === 2 &&
      document.querySelectorAll("#table-body tr").length === 2,
  );
  assert.equal(await page.locator("#table-body tr").count(), 2);
  assert.equal(
    await page
      .locator(
        "#table-body .catalog-sticky-col, #table-body .watchlist-sticky-ticker",
      )
      .count(),
    0,
  );
  console.log(
    "PASS: scoped selection, serialized paging (peak <= 6), dedup fallbacks, partial counts, 250-row chunks/full exports, persisted tabs, pinned cells/themes, animation, and upload",
  );
  // Exercise the checked-in feed too (not just fixtures).
  const real = await newPage();
  await real.goto(baseURL);
  await real.waitForSelector('input[data-checkbox="IVV"]');
  assert.equal(await real.locator('[data-sort="Frequency"]').count(), 1);
  await stickyCheck(real, "light");
  await stickyCheck(real, "dark");
  await real.fill("#search-input", "IVV");
  await real.click('input[data-checkbox="IVV"]');
  await real.click('[data-tab="Watchlist"]');
  await real.waitForFunction(
    () => !isHoldingsLoading && getDedupedWatchlistRows().length > 500,
  );
  await stickyCheck(real, "light", true);
  await stickyCheck(real, "dark", true);
  await real.click("#all-etfs-tab-btn");
  await real.fill("#search-input", "not-a-fund");
  assert.equal(
    await real.locator("#table-body td").getAttribute("colspan"),
    "25",
  );
  await real.fill("#search-input", "IVV");
  assert.ok(
    await real.evaluate(() =>
      generateFileContent()
        .split("\n")[0]
        .includes("SEC Yield,Frequency,YTD Return"),
    ),
  );
  // Wrapped chip lists must grow AND shrink smoothly, not just fade in/out.
  await real.click("#blacklist-btn");
  await real.waitForTimeout(400);
  const initialHeight = await real
    .locator("#blacklist-panel")
    .evaluate((el) => el.getBoundingClientRect().height);
  const manyTickers = await real.evaluate(() =>
    visibleCatalogFunds()
      .slice(0, 70)
      .map((r) => r.Ticker)
      .join(", "),
  );
  await real.fill("#blacklist-input", manyTickers);
  await real.click("#blacklist-add-btn");
  await real.waitForTimeout(400);
  const expandedHeight = await real
    .locator("#blacklist-panel")
    .evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(expandedHeight > initialHeight);
  await shot(real, "blacklist-wrapped");
  await real.click("#blacklist-clear-btn");
  await real.waitForTimeout(100);
  const shrinkingHeight = await real
    .locator("#blacklist-panel")
    .evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(
    shrinkingHeight > initialHeight && shrinkingHeight < expandedHeight,
  );
  await real.waitForTimeout(400);
  assert.equal(
    await real
      .locator("#blacklist-panel")
      .evaluate((el) => el.getBoundingClientRect().height),
    initialHeight,
  );
  await real.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await real
      .locator("#blacklist-panel")
      .evaluate((el) => getComputedStyle(el).transitionDuration),
    "0s",
  );
  await real.click("#blacklist-btn");

  // Deselect while a page is in flight; it may populate cache but never aggregation.
  const race = await newPage();
  await fixtures(race);
  await race.goto(baseURL);
  await race.waitForSelector('input[data-checkbox="T01"]');
  assert.equal(
    await race.evaluate(() => {
      toggleEtfSelection("T01");
      return watchlistCountLabel();
    }),
    "Loading…",
  );
  await race.waitForFunction(() => holdingsState("T01").next === 1);
  await race.evaluate(() => toggleEtfSelection("T01"));
  await race.waitForFunction(() => holdingsJobs.size === 0);
  assert.equal(await race.evaluate(() => getDedupedWatchlistRows().length), 0);
  await race.evaluate(() => toggleEtfSelection("T01"));
  await race.waitForFunction(() => holdingsState("T01").complete);
  assert.equal(
    await race.evaluate(() => getDedupedWatchlistRows().length),
    609,
  );

  // Reproduce filtered Catalog -> select visible -> Watchlist, including legacy migration.
  const filters = await newPage();
  await fixtures(filters);
  await filters.addInitScript(() => {
    if (localStorage.getItem("filter-test-seeded")) return;
    localStorage.setItem("filter-test-seeded", "yes");
    localStorage.setItem(
      "ishares-searches",
      JSON.stringify("old global filter"),
    );
    localStorage.setItem(
      "ishares-site-state",
      JSON.stringify({
        activeSheet: "ETF Catalog",
        tabs: {
          "static:ETF Catalog": {
            query: "Fixture1",
            sortKey: "Ticker",
            sortDir: "desc",
          },
        },
      }),
    );
  });
  await filters.goto(baseURL);
  await filters.waitForSelector('input[data-checkbox="T01"]');
  assert.equal(await filters.inputValue("#search-input"), "Fixture1");
  assert.equal(await filters.locator("#search-clear-btn").isVisible(), true);
  const inputBox = await filters.locator("#search-input").boundingBox();
  const clearBox = await filters.locator("#search-clear-btn").boundingBox();
  assert.ok(
    clearBox.x > inputBox.x + inputBox.width / 2 &&
      clearBox.x + clearBox.width <= inputBox.x + inputBox.width,
    "clear control must be on the right of the input",
  );
  await filters.waitForTimeout(400);
  await shot(filters, "search-clear-light");
  await filters.click("#theme-toggle");
  await filters.waitForTimeout(400);
  await shot(filters, "search-clear-dark");
  await filters.click("#select-all-checkbox");
  assert.deepEqual(await filters.evaluate(() => [...selectedETFs]), ["T01"]);
  await filters.click('[data-tab="Watchlist"]');
  assert.equal(await filters.inputValue("#search-input"), "");
  assert.equal(await filters.locator("#search-clear-btn").isVisible(), false);
  await filters.fill("#search-input", "COMMON");
  await filters.click('[data-sort="Name"]');
  await filters.waitForFunction(() => !isHoldingsLoading);
  const savedFilters = () =>
    filters.evaluate(() =>
      JSON.parse(localStorage.getItem("ishares-tab-filters")),
    );
  assert.deepEqual(await savedFilters(), {
    "static:ETF Catalog": "Fixture1",
    "static:Watchlist": "COMMON",
  });
  assert.deepEqual(
    await filters.evaluate(
      () => JSON.parse(localStorage.getItem("ishares-site-state")).sheetFilter,
    ),
    await savedFilters(),
  );
  await filters.reload();
  await filters.waitForSelector('[data-sort="Name"]');
  assert.equal(await filters.inputValue("#search-input"), "COMMON");
  assert.equal(await filters.locator("#search-clear-btn").isVisible(), true);
  await filters.click("#all-etfs-tab-btn");
  assert.equal(await filters.inputValue("#search-input"), "Fixture1");
  await filters.click("#search-clear-btn");
  assert.equal(await filters.inputValue("#search-input"), "");
  assert.equal(await filters.locator("#search-clear-btn").isVisible(), false);
  assert.equal(
    await filters.evaluate(() => document.activeElement.id),
    "search-input",
  );
  assert.equal(await filters.locator("input[data-checkbox]").count(), 8);
  assert.deepEqual(await savedFilters(), { "static:Watchlist": "COMMON" });
  assert.equal(await filters.evaluate(() => sortKey), "Ticker");
  await filters.reload();
  await filters.waitForSelector("#select-all-checkbox");
  assert.equal(await filters.inputValue("#search-input"), "");
  await filters.click('[data-tab="Watchlist"]');
  assert.equal(await filters.inputValue("#search-input"), "COMMON");
  await filters.locator("#search-clear-btn").focus();
  await filters.keyboard.press("Enter");
  assert.equal(await filters.inputValue("#search-input"), "");
  assert.equal(
    await filters.evaluate(() => document.activeElement.id),
    "search-input",
  );
  assert.deepEqual(await savedFilters(), {});
  await filters.fill("#search-input", "security");
  await filters.click("#all-etfs-tab-btn");
  await filters.fill("#search-input", "Fixture2");
  await filters.click("#reset-btn");
  await filters.waitForFunction(
    () => activeSheetName === "ETF Catalog" && selectedETFs.size === 0,
  );
  assert.deepEqual(await savedFilters(), {});
  assert.equal(await filters.locator("#search-clear-btn").isVisible(), false);
  assert.equal(
    await filters.evaluate(() => tabStates["static:Watchlist"].sortKey),
    "Name",
  );
  assert.equal(await filters.evaluate(() => sortKey), "Ticker");
  assert.equal(
    await filters.evaluate(() => localStorage.getItem("ishares-searches")),
    JSON.stringify("old global filter"),
  );
  console.log(
    "PASS: right-side filter clear (mouse/keyboard/focus), independent localStorage filters, legacy migration, reload, Clear preserving sorts",
  );

  // All ETFs text is navigation only; only its checkbox changes global selection.
  const navigation = await newPage();
  await fixtures(navigation);
  await navigation.goto(baseURL);
  await navigation.waitForSelector('input[data-checkbox="T01"]');
  await navigation.click("#all-etfs-tab-btn");
  assert.equal(await navigation.evaluate(() => selectedETFs.size), 0);
  await navigation.click('button[data-blacklist="T08"]');
  await navigation.fill("#search-input", "Fixture1");
  await navigation.click('[data-fund-view="T01"]');
  await navigation.waitForFunction(() => activeSheetName === "Holdings");

  const assertCatalogActive = async () => {
    await navigation.waitForFunction(
      () =>
        activeSheetName === "ETF Catalog" &&
        document.querySelector("#select-all-checkbox"),
    );
    assert.equal(
      await navigation
        .locator("#all-etfs-tab-btn")
        .getAttribute("aria-selected"),
      "true",
    );
    assert.equal(
      await navigation
        .locator('#selected-tabs-bar [aria-selected="true"]')
        .count(),
      0,
    );
    assert.equal(await navigation.inputValue("#search-input"), "Fixture1");
    assert.equal(await navigation.locator("input[data-checkbox]").count(), 1);
  };
  for (const tab of [
    "Holdings",
    "Historical",
    "Performance",
    "Distributions",
    "Watchlist",
  ]) {
    await navigation.click(`[data-tab="${tab}"]`);
    await navigation.fill("#search-input", `${tab} saved filter`);
    await navigation.click("#all-etfs-tab-btn");
    await assertCatalogActive();
    assert.deepEqual(await navigation.evaluate(() => [...selectedETFs]), [
      "T01",
    ]);
    assert.equal(
      await navigation.locator("#select-all-toggle").isChecked(),
      false,
    );

    await navigation.click(`[data-tab="${tab}"]`);
    assert.equal(
      await navigation.inputValue("#search-input"),
      `${tab} saved filter`,
    );
    await navigation.click("#select-all-toggle");
    await assertCatalogActive();
    assert.deepEqual(
      await navigation.evaluate(() => [...selectedETFs].sort()),
      tickers.slice(0, 7),
    );
    assert.equal(
      await navigation.locator("#select-all-toggle").isChecked(),
      true,
    );
    // Repeated label clicks never deselect selected ETFs either.
    await navigation.click("#all-etfs-tab-btn");
    assert.equal(await navigation.evaluate(() => selectedETFs.size), 7);

    await navigation.click(`[data-tab="${tab}"]`);
    await navigation.click("#select-all-toggle");
    await assertCatalogActive();
    assert.equal(await navigation.evaluate(() => selectedETFs.size), 0);
    assert.equal(
      await navigation.locator("#select-all-toggle").isChecked(),
      false,
    );
    await navigation.click('input[data-checkbox="T01"]');
  }
  // Keyboard activation of the label has the same navigation-only behavior.
  await navigation.click('[data-tab="Watchlist"]');
  await navigation.locator("#all-etfs-tab-btn").focus();
  await navigation.keyboard.press("Enter");
  await assertCatalogActive();
  assert.deepEqual(await navigation.evaluate(() => [...selectedETFs]), ["T01"]);
  await shot(navigation, "all-etfs-catalog-active");
  console.log(
    "PASS: All ETFs label navigates without selection; checkbox selects/deselects and navigates from all five detail/Watchlist tabs; blacklist and tab-local filters retained",
  );

  assert.deepEqual(errors, []);
  console.log(
    "PASS: checked-in 480-fund catalog + real IVV holdings, Frequency/export/empty state; no browser errors",
  );
} finally {
  await browser.close();
}
