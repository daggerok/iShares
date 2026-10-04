/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTROL_NAMES,
  RETURNS_BASIS,
  buildCatalogRow,
  buildMetrics,
  buildStandardFund,
  catalogFilterReasons,
  catalogFundFromRow,
  withYieldBasis,
  createRequestGate,
  cusipFromIsin,
  deriveAssetClass,
  deriveDistributionFrequency,
  deriveReturnMetrics,
  displayDate,
  feedCounts,
  frequencyInfo,
  installSystemCa,
  isCertError,
  isoDate,
  main,
  normalizeAssetClass,
  paginationPaths,
  parseAumRange,
  parseFundHeader,
  parseRange,
  parseSecYield,
  parseWorkbook,
  readConfig,
  resolveControls,
  returnFilterReasons,
  runtimeControls,
  selectUpdateBatch,
  setRootForTests,
  setSoftDeadlineForTests,
} from "./update-data";

// --- shared setup: pinned zone, no ambient fetch/exitCode/env leaks between tests ---

const realFetch = globalThis.fetch;
const realTZ = process.env.TZ;
const realSummary = process.env.GITHUB_STEP_SUMMARY;
const realLog = console.log;
const realWarn = console.warn;
beforeEach(() => {
  process.env.TZ = "UTC";
  delete process.env.GITHUB_STEP_SUMMARY;
  console.log = () => {};
  console.warn = () => {};
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exitCode = 0;
  console.log = realLog;
  console.warn = realWarn;
  if (realTZ === undefined) delete process.env.TZ;
  else process.env.TZ = realTZ;
  if (realSummary !== undefined) process.env.GITHUB_STEP_SUMMARY = realSummary;
});

const configFile = JSON.parse(readFileSync(new URL("./update-data.config.json", import.meta.url), "utf8"));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pct = (months: number) => (1.01 ** months - 1) * 100;
// 10 years of monthly +1% returns ending Dec 28 2024
const monthly = (from: number, to: number) => {
  const rows: Array<Record<string, string>> = [];
  for (let year = from; year <= to; year++) for (const month of MONTHS) rows.push({ Date: `${month} 28, ${year}`, Return: "1" });
  return { headers: ["Date", "Return"], rows };
};
const tenYears = monthly(2015, 2024);
const oneYear = { headers: tenYears.headers, rows: tenYears.rows.slice(-12) };
const returns = deriveReturnMetrics(tenYears);

const fund = {
  ticker: "IVV",
  portfolioId: "239726",
  name: "iShares Core S&P 500 ETF",
  fundPage: "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf",
  trailingYield: "1.25",
  yieldAsOf: "Jun 30, 2026",
  ytdReturn: "10.00",
  returnAsOf: "Jun 30, 2026",
  inceptionDate: "May 15, 2000",
  grossExpenseRatio: "0.03",
  netExpenseRatio: "0.03",
  netAssets: "700,000,000,000",
  type: "iShares ETF",
};

const manifest = (totalRows: number) => ({ totalRows, pageSize: 250, pageCount: 1, pages: ["./holdings/001.json"] });
const facts = {
  fund,
  category: "Equity",
  categorySource: "test",
  isin: "US4642872000",
  navValue: 767.129781,
  navAsOf: "Oct 01, 2026",
  holdingsAsOf: "",
  returns,
  secYield: { value: "0.94", asOf: "Aug 31, 2026" },
  frequencyCode: "04 - Quarterly",
  distributionSheet: {
    headers: ["Record Date", "Ex-Date", "Payable Date", "Total Distribution"],
    rows: [
      { "Record Date": "Mar 17, 2026", "Ex-Date": "Mar 17, 2026", "Payable Date": "Mar 20, 2026", "Total Distribution": "1.78" },
      { "Record Date": "Jun 15, 2026", "Ex-Date": "Jun 15, 2026", "Payable Date": "Jun 18, 2026", "Total Distribution": "2.00" },
    ],
  },
  holdings: manifest(508),
  history: manifest(6637),
  download: "https://example.test/download",
  fundHeader: "https://example.test/header",
};

// --- controls: resolver, strict validation, aliases, config file ---

describe("controls", () => {
  test("precedence: file < advanced < nonblank inputs < env, env alias beats plain name, blank input is ignored", () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: "IVV" }, { CONCURRENCY: 3, TICKERS: "AGG" }, { CONCURRENCY: "4", TICKERS: "" }, { ISHARES_CONCURRENCY: "5", CONCURRENCY: "6" });
    expect(c.CONCURRENCY).toBe("5");
    expect(c.TICKERS).toBe("AGG");
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: "4" }).CONCURRENCY).toBe("4");
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: "4" }, { CONCURRENCY: "7" }).CONCURRENCY).toBe("7");
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: "" }).CONCURRENCY).toBe("2");
    expect(resolveControls({ TICKERS: "IVV" }, {}, {}, { TICKERS: "" }).TICKERS).toBe("");
    expect(resolveControls({ STORE_RAW_DOWNLOADS: true }, {}, {}, { STORE_RAW_DOWNLOADS: "false" }).STORE_RAW_DOWNLOADS).toBe("false");
  });

  test("brand env aliases keep working", () => {
    const read = (env: Record<string, string>) => readConfig(resolveControls(configFile, {}, {}, env));
    expect(read({ ISHARES_LIMIT: "3" }).maxFetches).toBe(3);
    expect(read({ HISTORICAL_PAGE_SIZE: "37" }).historyPageSize).toBe(37);
    expect(read({ ISHARES_STORE_RAW_DOWNLOADS: "yes" }).storeRawDownloads).toBe(true);
  });

  test("strict validation: unknown names, bad values, ranges and CR/LF/NUL are errors, never fallbacks", () => {
    const bad: unknown[] = [
      { UNKNOWN: 1 }, { OUTPUT_DIR: "/tmp/x" }, { TICKERS: ["IVV"] }, { TICKERS: "IVV\nEVIL=yes" },
      { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: "-1" },
      { VERBOSE: "maybe" }, { STORE_RAW_DOWNLOADS: "maybe" }, { USE_SYSTEM_CA: "maybe" },
      { TER: "1" }, { SEC_YIELD: "1:2:3" }, { AUM: "1:2:3" }, { PERFORMANCE_1Y: "5" }, { TOTAL_RETURN_5Y: "20:5" },
      null, [],
    ];
    for (const value of bad) expect(() => resolveControls(value), JSON.stringify(value)).toThrow();
    expect(() => resolveControls({}, { TICKERS: "x\rfoo" })).toThrow();
    expect(() => resolveControls({}, {}, {}, { ISHARES_TICKERS: "x\0bad" })).toThrow();
    expect(() => resolveControls({}, {}, {}, { USE_SYSTEM_CA: "maybe" })).toThrow();
    expect(() => resolveControls({}, [])).toThrow();
    for (const value of ["1e1", "0x10", "2.5", "-1", "abc"]) expect(() => readConfig({ MAX_RETRIES: value })).toThrow("integer");
    for (const mode of ["auto", "true", "false", "TRUE", "Auto"]) expect(resolveControls({ USE_SYSTEM_CA: mode }).USE_SYSTEM_CA).toBe(mode.toLowerCase());
  });

  test("ranges are inclusive and strict, AUM accepts size names", () => {
    expect(parseRange("5:20")).toEqual({ min: 5, max: 20 });
    expect(parseRange("5:")).toEqual({ min: 5, max: undefined });
    expect(parseRange(":20")).toEqual({ min: undefined, max: 20 });
    expect(parseRange("-10%:12.5%")).toEqual({ min: -10, max: 12.5 });
    expect(parseRange(":")).toBeUndefined();
    expect(() => parseRange("5")).toThrow("exactly one colon");
    expect(() => parseRange("20:5")).toThrow("minimum cannot exceed");
    expect(parseAumRange("micro:small")).toEqual({ min: 10_000_000, max: 2_000_000_000, maxExclusive: true, source: "micro:small" });
    expect(parseAumRange(":")).toBeUndefined();
  });

  test("config file: keys equal CONTROL_NAMES, all strings, defaults mean no filter, runtime path reads the same file", async () => {
    expect(Object.keys(configFile).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(configFile)) expect(typeof value).toBe("string");
    const config = readConfig(resolveControls(configFile));
    expect(config).toMatchObject({ tickers: [], maxFetches: 0, requestSleepSeconds: 0, concurrency: 4, holdingsPageSize: 250, historyPageSize: 1000, maxRetries: 2, storeRawDownloads: false });
    for (const range of [config.aumRange, config.terRange, config.secYieldRange, config.dividendYieldRange]) expect(range).toBeUndefined();
    expect(config.performanceRanges).toEqual({});
    expect(config.totalReturnRanges).toEqual({});
    expect(resolveControls(configFile, {}, {}, {})).toEqual(resolveControls(configFile));
    expect(await runtimeControls({})).toEqual(resolveControls(configFile));
    expect((await runtimeControls({ TICKERS: "IVV" })).TICKERS).toBe("IVV");
  });

  test("settings parse into the config: tickers, ranges, page sizes", () => {
    const config = readConfig({
      TICKERS: "ivv, DGRO;DVY IVV", AUM: "micro:small", DIVIDEND_YIELD: "1%:4.5%",
      PERFORMANCE_3Y: "5:20", TOTAL_RETURN_10Y: ":300", HISTORY_PAGE_SIZE: "777",
    });
    expect(config.tickers).toEqual(["IVV", "DGRO", "DVY"]);
    expect(config.dividendYieldRange).toEqual({ min: 1, max: 4.5 });
    expect(config.performanceRanges["3Y"]).toEqual({ min: 5, max: 20 });
    expect(config.totalReturnRanges["10Y"]).toEqual({ min: undefined, max: 300 });
    expect(config.historyPageSize).toBe(777);
  });

  test("catalog filters: AND logic, unavailable metrics are rejected, TER uses net then gross", () => {
    const filters = readConfig({ TICKERS: "IVV DGRO", AUM: "1B:2B", DIVIDEND_YIELD: "1:2" });
    expect(catalogFilterReasons({ ...fund, netAssets: "1,500,000,000" }, filters)).toEqual([]);
    const missing = catalogFilterReasons({ ...fund, netAssets: "—", trailingYield: "—" }, readConfig({ AUM: "1:", DIVIDEND_YIELD: "1:" }));
    expect(missing).toEqual(expect.arrayContaining(["AUM unavailable", "dividend yield unavailable"]));
    const ter = readConfig({ TER: ":0.1" });
    expect(catalogFilterReasons(fund, ter)).toEqual([]);
    expect(catalogFilterReasons({ ...fund, netExpenseRatio: "0.50" }, ter)).toEqual(["expense ratio range"]);
    expect(catalogFilterReasons({ ...fund, netExpenseRatio: "—", grossExpenseRatio: "0.05" }, ter)).toEqual([]);
    expect(catalogFilterReasons({ ...fund, netExpenseRatio: "—", grossExpenseRatio: "—" }, ter)).toEqual(["expense ratio unavailable"]);
  });

  test("return filters: inclusive ranges, a fund too young for a bounded horizon is excluded", () => {
    const metrics = returns;
    expect(returnFilterReasons(metrics, readConfig({ PERFORMANCE_3Y: "12:13", TOTAL_RETURN_3Y: "40:50" }))).toEqual([]);
    expect(returnFilterReasons(metrics, readConfig({ PERFORMANCE_3Y: "13:", TOTAL_RETURN_3Y: ":40" }))).toHaveLength(2);
    const young = deriveReturnMetrics(oneYear);
    expect(returnFilterReasons(young, readConfig({ PERFORMANCE_10Y: "10:", TOTAL_RETURN_10Y: "100:" }))).toEqual(["PERFORMANCE_10Y unavailable", "TOTAL_RETURN_10Y unavailable"]);
    expect(returnFilterReasons(young, readConfig({}))).toEqual([]);
  });
});

// --- parsing: one tiny inline sample per provider payload ---

describe("parsing", () => {
  test("workbook: a tickerless bond sheet skips fund metadata rows and keeps identifiers", () => {
    const rows = [
      ["Inception Date", "Sep 22, 2003"],
      ["Number of Securities", "2"],
      ["Name", "CUSIP", "Asset Class", "Market Value"],
      ["Published bond", "123456789", "Fixed Income", "100"],
      ["Cash", "--", "Cash", "20"],
    ];
    const cells = (row: string[]) => row.map((value) => `<ss:Cell><ss:Data ss:Type="String">${value}</ss:Data></ss:Cell>`).join("");
    const xml = `<ss:Worksheet ss:Name="Holdings"><ss:Table>${rows.map((row) => `<ss:Row>${cells(row)}</ss:Row>`).join("")}</ss:Table></ss:Worksheet>`;
    const sheet = parseWorkbook(xml).Holdings;
    expect(sheet.headers).toEqual(rows[2]);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0].CUSIP).toBe("123456789");
  });

  test("fund header: SEC yield without the percent sign, asset class, ISIN; blanks become null", () => {
    const header = (value?: string) => ({ componentsByNameMap: { fundHeader: { containersByNameMap: { yieldsAndRates: { dataPointsByNameMap: {
      thirtyDaySecYield: value === undefined ? {} : { formattedValue: value, formattedAsOfDate: "Aug 20, 2026" },
    } } } } } });
    expect(parseSecYield(header("4.68%"))).toEqual({ value: "4.68", asOf: "Aug 20, 2026" });
    for (const empty of [header(), header("—"), { componentsByNameMap: {} }, null]) expect(parseSecYield(empty)).toBeNull();
    const names = (points: object) => ({ componentsByNameMap: { fundHeader: { containersByNameMap: { fundName: { dataPointsByNameMap: points } } } } });
    expect(parseFundHeader(names({ assetClass: { value: "Multi Asset" }, productIsin: { value: "US4642898674" } }))).toEqual({ secYield: null, assetClass: "Multi-asset", isin: "US4642898674" });
    expect(parseFundHeader({})).toEqual({ secYield: null, assetClass: null, isin: null });
    expect(parseFundHeader(names({ productIsin: { value: "-" } })).isin).toBeNull();
    expect(cusipFromIsin("US4642898674")).toBe("464289867");
    expect(cusipFromIsin("IE00B4L5Y983")).toBeNull();
    expect(cusipFromIsin(null)).toBeNull();
  });

  test("distribution frequency: cadence from intervals in any row order, never guessed from bad history", () => {
    const sheet = (dates: string[], header = "Ex-Date") => ({ headers: [header], rows: dates.map((date) => ({ [header]: date })) });
    const cases: Array<[string[], string, string?]> = [
      [["2026-01-02", "2026-02-02", "2026-03-02"], "01 - Monthly"],
      [["2025-12-20", "2025-06-20", "2025-09-20"], "04 - Quarterly"],
      [["2025-01-02", "2025-07-02", "2026-01-02"], "06 - Semi-annually"],
      [["2024-12-20", "2025-12-20", "2026-12-20"], "12 - Annually", "Payable Date"],
      [[], "00 - None"],
      [["", "--", "bad date"], "00 - None"],
      [["2026-01-02", "2026-01-02", "2026-02-02"], "00 - None"],
      [["2026-01-02", "2026-02-02", "2026-05-02"], "99 - Irregular"],
      [["2026-01-01", "2026-01-08", "2026-01-15"], "99 - Irregular"],
    ];
    for (const [dates, expected, header] of cases) expect(deriveDistributionFrequency(sheet(dates, header))).toBe(expected);
    expect(deriveDistributionFrequency()).toBe("00 - None");
    const rows = ["2026-01-02", "2026-02-02", "2026-03-02", "2026-03-02"].map((d) => ({ "Ex-Date": d, "Payable Date": "2026-04-01" }));
    expect(deriveDistributionFrequency({ headers: ["Payable Date", "Ex-Date"], rows })).toBe("01 - Monthly");
    expect(deriveDistributionFrequency({ headers: ["Ex-Date", "Payable Date"], rows: rows.map((r) => ({ "Ex-Date": "--", "Payable Date": r["Ex-Date"] })) })).toBe("01 - Monthly");
    expect(frequencyInfo("01 - Monthly")).toEqual({ label: "Monthly", paymentsPerYear: 12 });
    expect(frequencyInfo("99 - Irregular")).toEqual({ label: "Irregular", paymentsPerYear: null });
    expect(frequencyInfo("00 - None")).toEqual({ label: "None", paymentsPerYear: null });
  });

  test("asset class: product header first, holdings market-value mix as the fallback", () => {
    const holding = (assetClass: string, value: number) => ({ "Asset Class": assetClass, "Market Value": String(value) });
    expect(normalizeAssetClass(" Fixed  Income ")).toBe("Fixed Income");
    expect(normalizeAssetClass("-")).toBeNull();
    expect(deriveAssetClass([holding("Equity", 98), holding("Cash", 50), holding("Futures", 5)])).toBe("Equity");
    expect(deriveAssetClass([holding("Equity", 60), holding("Fixed Income", 40)])).toBe("Multi-asset");
    expect(deriveAssetClass([holding("Fixed Income", 90), holding("Money Market", 40), holding("Equity", 1)])).toBe("Fixed Income");
    expect(deriveAssetClass([holding("Money Market", 95), holding("Fixed Income", 5)])).toBe("Money Market");
    expect(deriveAssetClass([holding("Cash", 100)])).toBe("ETF");
    expect(deriveAssetClass([])).toBe("ETF");
  });

  test("dates and page paths: stable ISO and display forms, numbered pages", () => {
    expect(isoDate("Jun 30, 2026")).toBe("2026-06-30");
    expect(isoDate("Jun 3 2026")).toBe("2026-06-03");
    expect(displayDate("Jun 30, 2026")).toBe("Jun 30 2026");
    for (const empty of ["—", ""]) expect(isoDate(empty)).toBeNull();
    expect(displayDate(undefined)).toBeNull();
    expect(paginationPaths("holdings", 501, 250)).toEqual(["./holdings/001.json", "./holdings/002.json", "./holdings/003.json"]);
    expect(paginationPaths("history", 0, 1000)).toEqual([]);
    expect(() => paginationPaths("history", 1, 0)).toThrow("pageSize");
  });
});

// --- metrics: horizons, null never 0, one key set, row and meta layout ---

describe("metrics", () => {
  test("cumulative and annualized returns per horizon, month-end basis", () => {
    expect(returns.asOfDate).toBe("Dec 28, 2024");
    expect(returns.totalReturn.YTD).toBeCloseTo(pct(12), 6);
    expect(returns.totalReturn["3Y"]).toBeCloseTo(pct(36), 6);
    expect(returns.performance["3Y"]).toBeCloseTo(pct(12), 6);
    expect(returns.performance["10Y"]).toBeCloseTo(pct(12), 6);
    expect(returns.siCum).toBeCloseTo(pct(120), 6);
    expect(returns.siAnn).toBeCloseTo(pct(12), 6);
  });

  test("since-inception annualized needs 12 contiguous months, a gap publishes neither number", () => {
    const series = (count: number, skip = -1) => ({
      headers: ["Date", "Return"],
      rows: Array.from({ length: count }, (_, i) => i).filter((i) => i !== skip)
        .map((i) => ({ Date: `${MONTHS[i % 12]} 28, ${2023 + Math.floor(i / 12)}`, Return: "1" })),
    });
    expect(deriveReturnMetrics(series(7)).siAnn).toBeNull();
    expect(deriveReturnMetrics(series(7)).siCum).toBeCloseTo(pct(6), 6);
    expect(deriveReturnMetrics(series(3)).siAnn).toBeNull();
    expect(deriveReturnMetrics(series(12)).siAnn).toBeCloseTo(pct(12), 6);
    expect(deriveReturnMetrics(series(30)).siAnn).toBeCloseTo(pct(12), 6);
    const gap = deriveReturnMetrics(series(30, 10));
    expect([gap.siAnn, gap.siCum]).toEqual([null, null]);
  });

  test("buildMetrics: fixed key set, tr*/cagr* mapping, null (never 0) for young funds and missing data", () => {
    const keys = ["ytd", "tr1y", "tr3y", "tr5y", "tr10y", "cagr3y", "cagr5y", "cagr10y", "siAnn", "dividendYield", "dividendYieldText", "dividendYieldBasis", "secYield", "secYieldText", "returnsBasis", "performanceAsOf"];
    const full = buildMetrics(returns, 1.06, 0.94);
    expect(Object.keys(full)).toEqual(keys);
    expect(full.tr3y).toBeCloseTo(pct(36), 6);
    expect(full.cagr3y).toBeCloseTo(pct(12), 6);
    expect(full.dividendYieldText).toBe("1.06%");
    expect(full.dividendYieldBasis).toBe("official-trailing-12m");
    expect(buildMetrics(returns, 0, null).dividendYieldBasis).toBe("official-trailing-12m");
    expect(buildMetrics(returns, null, null).dividendYieldBasis).toBeNull();
    expect(full.returnsBasis).toBe(RETURNS_BASIS);
    expect(full.returnsBasis).toBeTruthy();
    expect(full.performanceAsOf).toBe("2024-12-28");
    const young = buildMetrics(deriveReturnMetrics(oneYear), null, null);
    expect(Object.keys(young)).toEqual(keys);
    expect([young.tr3y, young.tr5y, young.tr10y, young.cagr3y, young.cagr10y, young.dividendYield, young.secYield]).toEqual([null, null, null, null, null, null, null]);
    expect(young.secYieldText).toBe("—");
    const none = buildMetrics(deriveReturnMetrics(undefined), null, null);
    expect(Object.keys(none)).toEqual(keys);
    expect([none.ytd, none.performanceAsOf]).toEqual([null, null]);
  });

  test("index row and meta use the standard layout", () => {
    const { row, meta } = buildStandardFund(facts);
    expect(Object.keys(row).slice(0, 9)).toEqual(["ticker", "name", "category", "fundPage", "dataFile", "cusip", "isin", "ter", "terValue"]);
    expect(row).toMatchObject({
      ticker: "IVV", category: "Equity", dataFile: "./funds/IVV/meta.json", cusip: "464287200", isin: "US4642872000",
      ter: "0.03%", terValue: 0.03, nav: "$767.13", aum: "$700.00 B", aumValue: 700_000_000_000,
      asOfDate: "Oct 01 2026", inceptionDate: "May 15 2000", holdings: 508, history: 6637,
    });
    expect(row.distributions).toEqual({ frequency: "Quarterly", exDate: "06/15/2026", dividend: "2.00" });
    expect(row.metrics.tr1y).toBe(returns.totalReturn["1Y"]);
    expect(row.metrics.secYield).toBe(0.94);
    expect(Object.keys(meta)).toEqual([
      "ticker", "name", "category", "categoryPath", "providerIds", "source", "identifiers", "inception",
      "expenseRatio", "nav", "marketPrice", "premiumDiscount", "aum", "yields", "returns", "officialReturns",
      "distributions", "holdings", "history", "worksheets",
    ]);
    expect(meta.identifiers).toEqual({ cusip: "464287200", isin: "US4642872000", indexTicker: null });
    expect(meta.inception.fundInceptionDate).toBe("2000-05-15");
    expect(meta.distributions.paymentsPerYear).toBe(4);
    expect(meta.yields.secYieldKind).toContain("Aug 31, 2026");
  });

  test("a fund without a download is a catalog row with null metrics and dataFile null, and survives a round trip", () => {
    const full = buildStandardFund(facts).row;
    const row = buildCatalogRow(fund);
    expect(row).toMatchObject({ dataFile: null, holdings: 0, history: 0, category: "ETF", aumValue: 700_000_000_000 });
    expect(row.metrics.tr1y).toBeNull();
    expect(row.metrics.dividendYield).toBe(1.25);
    expect(Object.keys(row.metrics)).toEqual(Object.keys(full.metrics));
    expect(row.metrics.dividendYieldBasis).toBe("official-trailing-12m");
    const noYield = buildCatalogRow({ ...fund, trailingYield: "—" });
    expect([noYield.metrics.dividendYield, noYield.metrics.dividendYieldBasis]).toEqual([null, null]);
    const old = { ...full, metrics: Object.fromEntries(Object.entries(full.metrics).filter(([key]) => key !== "dividendYieldBasis")) };
    const kept = withYieldBasis(old);
    expect(Object.keys(kept.metrics)).toEqual(Object.keys(full.metrics));
    expect(kept.metrics.dividendYieldBasis).toBe("official-trailing-12m");
    expect(withYieldBasis({ ...old, metrics: { ...old.metrics, dividendYield: null } }).metrics.dividendYieldBasis).toBeNull();
    expect(Object.keys(buildStandardFund(facts).meta.yields)).toContain("dividendYieldBasis");
    expect(feedCounts([row, full])).toEqual({ funds: 2, holdings: 508, history: 6637 });
    const back = catalogFundFromRow(full);
    expect(back).toMatchObject({ ticker: "IVV", portfolioId: "239726", netExpenseRatio: "0.03", grossExpenseRatio: "0.03", netAssets: "700000000000" });
    expect(catalogFilterReasons(back, readConfig({ AUM: "large:", TER: ":0.05", DIVIDEND_YIELD: "1:2" }))).toEqual([]);
    const legacy = { ...fund, dataFile: "./funds/IVV/meta.json" };
    expect(catalogFundFromRow(legacy)).toBe(legacy);
  });
});

// --- pipeline: main() against a temporary feed directory and a fake ishares.com ---

type World = {
  all: string[]; // every fund the fake provider knows (portfolio id = 100 + position)
  catalog: string[]; // funds listed on the catalog page
  metal: Set<string>; // physical metal trusts: the workbook has no securities list
  failDownload: Set<string>; // answers HTTP 404 for the workbook
  failHeader: boolean; // answers HTTP 404 for the fund header JSON
  secYield: string;
  delayMs: number;
};

const cell = (value: string) => `<ss:Cell><ss:Data ss:Type="String">${value}</ss:Data></ss:Cell>`;
const sheetXml = (name: string, rows: string[][]) =>
  `<ss:Worksheet ss:Name="${name}"><ss:Table>${rows.map((row) => `<ss:Row>${row.map(cell).join("")}</ss:Row>`).join("")}</ss:Table></ss:Worksheet>`;

function workbook(ticker: string, metal: boolean): string {
  const performance = [["Date", "Return"], ...monthly(2023, 2024).rows.map((r) => [r.Date, r.Return])];
  const head = ["Ticker", "Name", "Asset Class", "Market Value", "As Of Date"];
  const holdings = metal ? [head] : [head, [ticker, `${ticker} Corp`, "Equity", "100", "Sep 25, 2026"]];
  return `<ss:Workbook>${[
    sheetXml("Holdings", holdings),
    sheetXml("Historical", [["As Of", "NAV per Share"], ["Sep 25, 2026", "50.25"], ["Sep 24, 2026", "50.00"]]),
    sheetXml("Performance", performance),
  ].join("")}</ss:Workbook>`;
}

function installIsharesMock(world: World) {
  const requests: string[] = [];
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      if (world.delayMs) await new Promise((resolve) => setTimeout(resolve, world.delayMs));
      if (url.includes("etf-investments")) {
        const rows = world.catalog.map((ticker) => {
          const id = 100 + world.all.indexOf(ticker);
          return `<tr><td><a href="/us/products/${id}/${ticker.toLowerCase()}-fund">${ticker}</a></td><td>iShares ${ticker} ETF</td><td>1.25</td><td>Jun 30, 2026</td><td>10.00</td><td>Jun 30, 2026</td><td>May 15, 2000</td><td>0.03</td><td>0.03</td><td>700,000,000</td></tr>`;
        });
        return new Response(`<table>${rows.join("")}</table>`);
      }
      const id = Number(/portfolioId=(\d+)/.exec(url)?.[1]);
      const ticker = world.all[id - 100];
      if (url.includes("component=fundHeader")) {
        if (world.failHeader) return new Response("nope", { status: 404 });
        return new Response(JSON.stringify({ componentsByNameMap: { fundHeader: { containersByNameMap: {
          yieldsAndRates: { dataPointsByNameMap: { thirtyDaySecYield: { formattedValue: world.secYield, formattedAsOfDate: "Sep 24, 2026" } } },
          fundName: { dataPointsByNameMap: { assetClass: { value: "Equity" }, productIsin: { value: "US4642898674" } } },
        } } } }));
      }
      if (url.includes("component=fundDownload")) {
        if (world.failDownload.has(ticker)) return new Response("nope", { status: 404 });
        return new Response(workbook(ticker, world.metal.has(ticker)));
      }
      return new Response("unexpected", { status: 500 });
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  return { requests, peak: () => peak };
}

const newWorld = (all: string[], extra: Partial<World> = {}): World => ({
  all, catalog: all, metal: new Set(), failDownload: new Set(), failHeader: false, secYield: "4.20%", delayMs: 0, ...extra,
});

// Fresh feed directory per call; main gets an explicit env, so exported workflow variables never leak in
async function withFeed(body: (feed: {
  dir: string;
  run: (world: World, env?: Record<string, string>) => ReturnType<typeof main>;
  files: () => Record<string, string>;
  index: () => { funds: Array<Record<string, any>>; generatedAt: string };
  meta: (ticker: string) => Record<string, any>;
  peak: () => number;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ishares-test-"));
  setRootForTests(pathToFileURL(`${dir}/`));
  let mock: ReturnType<typeof installIsharesMock> | null = null;
  const walk = (root: string, out: Record<string, string> = {}) => {
    for (const name of readdirSync(root).sort()) {
      const full = join(root, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else out[full.slice(dir.length)] = readFileSync(full, "utf8");
    }
    return out;
  };
  try {
    await body({
      dir,
      run: (world, env = {}) => {
        mock = installIsharesMock(world);
        return main([], { REQUEST_SLEEP: "0", MAX_RETRIES: "1", USE_SYSTEM_CA: "false", ...env });
      },
      files: () => walk(dir),
      index: () => JSON.parse(readFileSync(join(dir, "index.json"), "utf8")),
      meta: (ticker) => JSON.parse(readFileSync(join(dir, "funds", ticker, "meta.json"), "utf8")),
      peak: () => mock?.peak() ?? 0,
    });
  } finally {
    setSoftDeadlineForTests(25 * 60 * 1000);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pipeline", () => {
  test("a one-ticker run keeps every other fund's row and files", async () => {
    await withFeed(async ({ run, files, index }) => {
      const world = newWorld(["AAA", "BBB", "CCC"]);
      await run(world);
      const before = files();
      expect(index().funds).toHaveLength(3);
      await run(world, { TICKERS: "BBB" });
      expect(index().funds.map((f) => f.ticker)).toEqual(["AAA", "BBB", "CCC"]);
      expect(files()).toEqual(before);
    });
  });

  test("a second identical run writes nothing, stamps included, and leaves no temp files", async () => {
    await withFeed(async ({ run, files, index }) => {
      const world = newWorld(["AAA", "BBB", "GAU"], { metal: new Set(["GAU"]) });
      await run(world);
      const before = files();
      const summary = await run(world);
      expect(summary).toMatchObject({ updated: 0, unchanged: 3, failed: 0 });
      expect(files()).toEqual(before);
      expect(Object.keys(before).filter((name) => name.includes(".tmp-"))).toEqual([]);
      expect(index().generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  test("a failed source keeps the fund exactly as published, also when every fund fails or the workbook loses its holdings", async () => {
    await withFeed(async ({ run, files }) => {
      const world = newWorld(["AAA", "BBB"]);
      await run(world);
      const before = files();
      world.failDownload = new Set(["AAA", "BBB"]);
      expect(await run(world)).toMatchObject({ failed: 2, updated: 0, unchanged: 0 });
      expect(files()).toEqual(before);
      world.failDownload = new Set();
      world.metal = new Set(["AAA"]); // holdings vanish for a fund that had them
      expect(await run(world)).toMatchObject({ failed: 1, updated: 0 });
      expect(files()).toEqual(before);
    });
  });

  test("a fund never fetched successfully is a catalog row with dataFile null and the same metrics keys", async () => {
    await withFeed(async ({ run, index, dir }) => {
      await run(newWorld(["AAA", "BBB"], { failDownload: new Set(["BBB"]) }));
      const rows = index().funds;
      const [ok, bare] = [rows.find((f) => f.ticker === "AAA")!, rows.find((f) => f.ticker === "BBB")!];
      expect(ok.dataFile).toBe("./funds/AAA/meta.json");
      expect(bare.dataFile).toBeNull();
      expect(bare.metrics.tr1y).toBeNull();
      expect(Object.keys(bare.metrics)).toEqual(Object.keys(ok.metrics));
      expect(ok.metrics.dividendYieldBasis).toBe("official-trailing-12m");
      expect(existsSync(join(dir, "funds", "BBB", "meta.json"))).toBe(false);
    });
  });

  test("a physical metal trust without a securities list still publishes NAV, returns and history", async () => {
    await withFeed(async ({ run, meta, index }) => {
      expect(await run(newWorld(["AAA", "GAU"], { metal: new Set(["GAU"]) }))).toMatchObject({ failed: 0, updated: 2 });
      const gold = meta("GAU");
      expect(gold.holdings).toMatchObject({ totalRows: 0, status: "empty" });
      expect(gold.history.totalRows).toBe(2);
      expect(gold.nav.value).toBe(50.25);
      expect(gold.officialReturns.performance["1Y"]).not.toBeNull();
      const row = index().funds.find((f) => f.ticker === "GAU")!;
      expect(row).toMatchObject({ navValue: 50.25, holdings: 0, history: 2, dataFile: "./funds/GAU/meta.json" });
      expect(row.metrics.performanceAsOf).toBe("2024-12-28");
    });
  });

  test("a truncated catalog never deletes funds, a single vanished fund is removed", async () => {
    await withFeed(async ({ run, index, dir }) => {
      const all = Array.from({ length: 10 }, (_, i) => `F${String(i).padStart(2, "0")}`);
      const world = newWorld(all);
      await run(world);
      world.catalog = all.slice(0, 3);
      await run(world);
      expect(index().funds).toHaveLength(10);
      expect(readdirSync(join(dir, "funds"))).toHaveLength(10);
      world.catalog = all.slice(0, 9);
      await run(world);
      expect(index().funds).toHaveLength(9);
      expect(existsSync(join(dir, "funds", "F09"))).toBe(false);
    });
  });

  test("a transient header failure keeps the published SEC yield, an honest blank replaces it with null", async () => {
    await withFeed(async ({ run, index }) => {
      const world = newWorld(["AAA"]);
      await run(world);
      expect(index().funds[0].metrics.secYield).toBe(4.2);
      world.failHeader = true;
      await run(world);
      expect(index().funds[0].metrics.secYield).toBe(4.2);
      world.failHeader = false;
      world.secYield = "-";
      await run(world);
      expect(index().funds[0].metrics.secYield).toBeNull();
    });
  });

  test("new funds are reported, an unknown TICKERS entry is an error", async () => {
    await withFeed(async ({ run }) => {
      const world = newWorld(["AAA", "BBB", "CCC"], { catalog: ["AAA", "BBB"] });
      await run(world);
      world.catalog = ["AAA", "BBB", "CCC"];
      expect((await run(world))?.newFunds).toEqual(["CCC"]);
      await expect(run(world, { TICKERS: "ZZZ" })).rejects.toThrow("not in the iShares catalog: ZZZ");
    });
  });

  test("the soft deadline stops new funds and still writes the index with the previous rows", async () => {
    await withFeed(async ({ run, files, index }) => {
      const world = newWorld(["AAA", "BBB"]);
      await run(world);
      const before = files();
      setSoftDeadlineForTests(0);
      expect((await run(world))?.attempted).toBe(0);
      expect(index().funds).toHaveLength(2);
      expect(files()).toEqual(before);
    });
  });

  test("batches continue after the saved ticker and wrap at the end", () => {
    const funds = ["AAXJ", "ACWI", "ACWV", "ACWX", "AGG"].map((ticker) => ({ ticker }));
    const pick = (size: number, last?: string) => selectUpdateBatch(funds, size, last).map((f) => f.ticker);
    expect(pick(2)).toEqual(["AAXJ", "ACWI"]);
    expect(pick(2, "ACWI")).toEqual(["ACWV", "ACWX"]);
    expect(pick(2, "AGG")).toEqual(["AAXJ", "ACWI"]);
    expect(pick(2, "MISSING")).toEqual(["AAXJ", "ACWI"]);
    expect(selectUpdateBatch(funds, 0, "AGG")).toEqual(funds);
  });
});

// --- network: concurrency, request pacing, timeout, retries, certificates ---

describe("network", () => {
  test("CONCURRENCY really runs funds in parallel: peak in-flight 1 at c=1, N at c=N", async () => {
    const all = ["A01", "A02", "A03", "A04", "A05", "A06"];
    for (const c of [1, 3]) {
      await withFeed(async ({ run, peak }) => {
        await run(newWorld(all, { delayMs: 15 }), { CONCURRENCY: String(c) });
        expect(peak()).toBe(c);
      });
    }
  });

  test("the request gate spreads callers that arrive in one tick over its lanes", async () => {
    const realNow = Date.now;
    Date.now = () => 1_000_000; // frozen clock: only the slot bookkeeping decides who waits
    try {
      const gate = createRequestGate(0.05, 2);
      const done: number[] = [];
      const calls = [0, 1, 2, 3].map((n) => gate().then(() => { done.push(n); }));
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(done.sort()).toEqual([0, 1]); // one call per lane starts at once, the rest wait an interval
      Date.now = realNow;
      await Promise.all(calls);
      expect(done.sort()).toEqual([0, 1, 2, 3]);
    } finally {
      Date.now = realNow;
    }
  });

  test("the timeout covers the body and retries are bounded: a stalled body fails after MAX_RETRIES+1 attempts", async () => {
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => realTimeout.call(AbortSignal, 30);
    let calls = 0;
    let aborted = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => { aborted++; controller.error(init.signal!.reason); });
          setTimeout(() => { try { controller.error(new Error("never aborted")); } catch {} }, 500); // keeps a missing signal from hanging
        },
      });
      return new Response(body); // headers arrive at once, the body never does
    }) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "ishares-test-"));
    setRootForTests(pathToFileURL(`${dir}/`));
    try {
      await expect(main([], { REQUEST_SLEEP: "0", MAX_RETRIES: "1", USE_SYSTEM_CA: "false" })).rejects.toThrow("catalog unavailable");
      expect([calls, aborted]).toEqual([2, 2]);
    } finally {
      AbortSignal.timeout = realTimeout;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("system CA: certificate errors are detected, auto restarts once on a cert error only, true restarts at once", async () => {
    expect(isCertError({ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" })).toBe(true);
    expect(isCertError(new Error("unable to get local issuer certificate"))).toBe(true);
    expect(isCertError(Object.assign(new Error("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }))).toBe(true);
    expect(isCertError({ code: "ECONNRESET" })).toBe(false);
    expect(isCertError(new Error("HTTP 403"))).toBe(false);

    const noReexec = (() => { throw new Error("reexec"); }) as () => never;
    installSystemCa("false", noReexec, false);
    installSystemCa("auto", noReexec, true);
    expect(globalThis.fetch).toBe(realFetch);

    let calls = 0;
    const reexec = (() => { calls++; return undefined as never; }) as () => never;
    installSystemCa("true", reexec, false);
    expect(calls).toBe(1);
    let failure: unknown = Object.assign(new Error("fetch failed"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" });
    globalThis.fetch = (async () => { if (failure) throw failure; return new Response("ok"); }) as typeof fetch;
    installSystemCa("auto", reexec, false);
    await globalThis.fetch("https://example.test");
    expect(calls).toBe(2);
    failure = new Error("ECONNRESET");
    await expect(globalThis.fetch("https://example.test")).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(2);
    failure = null;
    expect(await (await globalThis.fetch("https://example.test")).text()).toBe("ok");
  });
});
