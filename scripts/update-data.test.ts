/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CONTROL_NAMES,
  RETURNS_BASIS,
  buildCatalogRow,
  buildMetrics,
  buildStandardFund,
  catalogFundFromRow,
  cusipFromIsin,
  deriveAssetClass,
  displayDate,
  feedCounts,
  frequencyInfo,
  isoDate,
  normalizeAssetClass,
  parseFundHeader,
  installSystemCa,
  isCertError,
  catalogFilterReasons,
  deriveReturnMetrics,
  deriveDistributionFrequency,
  paginationPaths,
  parseAumRange,
  parseRange,
  parseSecYield,
  parseWorkbook,
  readConfig,
  resolveControls,
  returnFilterReasons,
  runtimeControls,
  selectUpdateBatch,
} from "./update-data";

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

describe("configuration", () => {
  test("parses strict inclusive return and AUM ranges", () => {
    expect(parseRange("5:20")).toEqual({ min: 5, max: 20 });
    expect(parseRange("5:")).toEqual({ min: 5, max: undefined });
    expect(parseRange(":20")).toEqual({ min: undefined, max: 20 });
    expect(parseRange(":")).toBeUndefined();
    expect(parseRange("-10%:12.5%")).toEqual({ min: -10, max: 12.5 });
    expect(() => parseRange("5")).toThrow("exactly one colon");
    expect(() => parseRange("20:5")).toThrow("minimum cannot exceed");
    expect(parseAumRange("micro:small")).toEqual({
      min: 10_000_000,
      max: 2_000_000_000,
      maxExclusive: true,
      source: "micro:small",
    });
    expect(parseAumRange(":")).toBeUndefined();
  });

  test("supports strict updater settings and aliases", () => {
    const config = readConfig({
      ISHARES_LIMIT: "3",
      TICKERS: "ivv, DGRO;DVY IVV",
      AUM: "micro:small",
      DIVIDEND_YIELD: "1%:4.5%",
      PERFORMANCE_3Y: "5:20",
      TOTAL_RETURN_10Y: ":300",
      HISTORY_PAGE_SIZE: "777",
      ISHARES_STORE_RAW_DOWNLOADS: "yes",
    });
    expect(config.maxFetches).toBe(3);
    expect(config.tickers).toEqual(["IVV", "DGRO", "DVY"]);
    expect(config.aumRange).toEqual({
      min: 10_000_000,
      max: 2_000_000_000,
      maxExclusive: true,
      source: "micro:small",
    });
    expect(config.dividendYieldRange).toEqual({ min: 1, max: 4.5 });
    expect(config.performanceRanges["3Y"]).toEqual({ min: 5, max: 20 });
    expect(config.totalReturnRanges["10Y"]).toEqual({ min: undefined, max: 300 });
    expect(config.storeRawDownloads).toBe(true);
    expect(config.maxRetries).toBe(2);
    expect(config.historyPageSize).toBe(777);
    expect(readConfig({ HISTORICAL_PAGE_SIZE: "37" }).historyPageSize).toBe(37);
  });
});

describe("pagination", () => {
  test("uses stable numeric paths and a fixed page size", () => {
    expect(paginationPaths("holdings", 501, 250)).toEqual([
      "./holdings/001.json",
      "./holdings/002.json",
      "./holdings/003.json",
    ]);
    expect(paginationPaths("history", 2000, 1000)).toEqual([
      "./history/001.json",
      "./history/002.json",
    ]);
    expect(paginationPaths("history", 0, 1000)).toEqual([]);
    expect(() => paginationPaths("history", 1, 0)).toThrow("pageSize");
  });
});

describe("batched updates", () => {
  const funds = ["AAXJ", "ACWI", "ACWV", "ACWX", "AGG"].map((ticker) => ({ ticker }));

  test("continues after the saved ticker and wraps at the end", () => {
    expect(selectUpdateBatch(funds, 2)).toEqual([{ ticker: "AAXJ" }, { ticker: "ACWI" }]);
    expect(selectUpdateBatch(funds, 2, "ACWI")).toEqual([
      { ticker: "ACWV" },
      { ticker: "ACWX" },
    ]);
    expect(selectUpdateBatch(funds, 2, "AGG")).toEqual([
      { ticker: "AAXJ" },
      { ticker: "ACWI" },
    ]);
    expect(selectUpdateBatch(funds, 0, "AGG")).toEqual(funds);
    expect(selectUpdateBatch(funds, 2, "MISSING")).toEqual([
      { ticker: "AAXJ" },
      { ticker: "ACWI" },
    ]);
  });
});

describe("catalog filters", () => {
  test("combines ticker, AUM, and dividend yield with AND logic", () => {
    expect(
      catalogFilterReasons(
        { ...fund, netAssets: "1,500,000,000" },
        readConfig({
          TICKERS: "IVV DGRO",
          AUM: "1B:2B",
          DIVIDEND_YIELD: "1:2",
        }),
      ),
    ).toEqual([]);
  });

  test("rejects unavailable catalog metrics when their filters are active", () => {
    const reasons = catalogFilterReasons(
      { ...fund, netAssets: "—", trailingYield: "—" },
      readConfig({ AUM: "1:", DIVIDEND_YIELD: "1:" }),
    );
    expect(reasons).toContain("AUM unavailable");
    expect(reasons).toContain("dividend yield unavailable");
  });
});

describe("return metrics and filters", () => {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const rows: Array<Record<string, string>> = [];
  for (let year = 2015; year <= 2024; year++) {
    for (let month = 0; month < 12; month++) {
      rows.push({ Date: `${months[month]} 28, ${year}`, Return: "1" });
    }
  }
  const metrics = deriveReturnMetrics({ headers: ["Date", "Return"], rows });

  test("derives cumulative returns and period-specific CAGR at quarter end", () => {
    expect(metrics.asOfDate).toBe("Dec 28, 2024");
    expect(metrics.totalReturn.YTD).toBeCloseTo((1.01 ** 12 - 1) * 100, 6);
    expect(metrics.totalReturn["3Y"]).toBeCloseTo((1.01 ** 36 - 1) * 100, 6);
    expect(metrics.performance["3Y"]).toBeCloseTo((1.01 ** 12 - 1) * 100, 6);
    expect(metrics.performance["10Y"]).toBeCloseTo((1.01 ** 12 - 1) * 100, 6);
    expect(metrics.siCum).toBeCloseTo((1.01 ** 120 - 1) * 100, 6);
    expect(metrics.siAnn).toBeCloseTo((1.01 ** 12 - 1) * 100, 6);
  });

  test("applies all configured ranges inclusively", () => {
    expect(
      returnFilterReasons(
        metrics,
        readConfig({ PERFORMANCE_3Y: "12:13", TOTAL_RETURN_3Y: "40:50" }),
      ),
    ).toEqual([]);
    expect(
      returnFilterReasons(
        metrics,
        readConfig({ PERFORMANCE_3Y: "13:", TOTAL_RETURN_3Y: ":40" }),
      ).length,
    ).toBe(2);
  });

  test("allows a fund when a requested long-period metric is unavailable", () => {
    const young = deriveReturnMetrics({ headers: ["Date", "Return"], rows: rows.slice(-12) });
    expect(
      returnFilterReasons(young, readConfig({ PERFORMANCE_10Y: "10:", TOTAL_RETURN_10Y: "100:" })),
    ).toEqual([]);
  });
});

describe("sec yield", () => {
  const header = (formattedValue?: string, asOf?: string) => ({
    componentsByNameMap: {
      fundHeader: {
        containersByNameMap: {
          yieldsAndRates: {
            dataPointsByNameMap: {
              thirtyDaySecYield:
                formattedValue === undefined
                  ? {}
                  : {
                      formattedValue,
                      formattedAsOfDate: asOf ?? "",
                    },
            },
          },
        },
      },
    },
  });

  test("reads the formatted 30-day SEC yield without the percent sign", () => {
    expect(parseSecYield(header("4.68%", "Aug 20, 2026"))).toEqual({
      value: "4.68",
      asOf: "Aug 20, 2026",
    });
  });

  test("returns null when the datapoint is missing or blank", () => {
    expect(parseSecYield(header())).toBeNull();
    expect(parseSecYield(header("—", "Aug 20, 2026"))).toBeNull();
    expect(parseSecYield({ componentsByNameMap: {} })).toBeNull();
    expect(parseSecYield(null)).toBeNull();
  });
});

describe("distribution frequency", () => {
  const sheet = (dates: string[], header = "Ex-Date") => ({
    headers: [header], rows: dates.map((date) => ({ [header]: date })),
  });
  test("derives supported cadences from intervals, independent of row order", () => {
    expect(deriveDistributionFrequency(sheet(["2026-01-02", "2026-02-02", "2026-03-02"]))).toBe("01 - Monthly");
    expect(deriveDistributionFrequency(sheet(["2025-12-20", "2025-06-20", "2025-09-20"]))).toBe("04 - Quarterly");
    expect(deriveDistributionFrequency(sheet(["2025-01-02", "2025-07-02", "2026-01-02"]))).toBe("06 - Semi-annually");
    expect(deriveDistributionFrequency(sheet(["2024-12-20", "2025-12-20", "2026-12-20"], "Payable Date"))).toBe("12 - Annually");
  });
  test("does not guess with missing, invalid, duplicate or mixed history", () => {
    expect(deriveDistributionFrequency()).toBe("00 - None");
    expect(deriveDistributionFrequency(sheet([]))).toBe("00 - None");
    expect(deriveDistributionFrequency(sheet(["", "--", "bad date"]))).toBe("00 - None");
    expect(deriveDistributionFrequency(sheet(["2026-01-02", "2026-01-02", "2026-02-02"]))).toBe("00 - None");
    expect(deriveDistributionFrequency(sheet(["2026-01-02", "2026-02-02", "2026-05-02"]))).toBe("99 - Irregular");
    expect(deriveDistributionFrequency(sheet(["2026-01-01", "2026-01-08", "2026-01-15"]))).toBe("99 - Irregular");
  });
  test("prefers Ex-Date, falls back to Payable Date and deduplicates events", () => {
    const rows = ["2026-01-02", "2026-02-02", "2026-03-02", "2026-03-02"].map((d) => ({ "Ex-Date": d, "Payable Date": "2026-04-01" }));
    expect(deriveDistributionFrequency({ headers: ["Payable Date", "Ex-Date"], rows })).toBe("01 - Monthly");
    expect(deriveDistributionFrequency({ headers: ["Ex-Date", "Payable Date"], rows: rows.map((r) => ({ "Ex-Date": "--", "Payable Date": r["Ex-Date"] })) })).toBe("01 - Monthly");
  });
});


test("tickerless bond worksheet skips fund metadata and retains identifiers", () => {
  const rows = [
    ["Inception Date", "Sep 22, 2003"],
    ["Number of Securities", "2"],
    ["Name", "CUSIP", "Asset Class", "Market Value"],
    ["Published bond", "123456789", "Fixed Income", "100"],
    ["Cash", "--", "Cash", "20"],
  ];
  const xml = `<ss:Worksheet ss:Name="Holdings"><ss:Table>${rows.map((row) => `<ss:Row>${row.map((value) => `<ss:Cell><ss:Data ss:Type="String">${value}</ss:Data></ss:Cell>`).join("")}</ss:Row>`).join("")}</ss:Table></ss:Worksheet>`;
  const sheet = parseWorkbook(xml).Holdings;
  expect(sheet.headers).toEqual(rows[2]);
  expect(sheet.rows).toHaveLength(2);
  expect(sheet.rows[0].CUSIP).toBe("123456789");
});

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json'));
const workflow = read('.github/workflows/update-data.yml');

test('config: configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'IVV' }, { CONCURRENCY: 3, TICKERS: 'AGG' }, { CONCURRENCY: '4', TICKERS: '' }, { ISHARES_CONCURRENCY: '5', CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('5'); expect(c.TICKERS).toBe('AGG');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }, { CONCURRENCY: '7' }).CONCURRENCY).toBe('7');
  expect(resolveControls({ TICKERS: 'IVV' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ STORE_RAW_DOWNLOADS: true }, {}, {}, { STORE_RAW_DOWNLOADS: 'false' }).STORE_RAW_DOWNLOADS).toBe('false');
  expect(readConfig(resolveControls({ MAX_RETRIES: 1 })).maxRetries).toBe(1);
});

test('config: legacy environment aliases keep working', () => {
  expect(readConfig(resolveControls(file(), {}, {}, { ISHARES_LIMIT: '3' })).maxFetches).toBe(3);
  expect(readConfig(resolveControls(file(), {}, {}, { HISTORICAL_PAGE_SIZE: '37' })).historyPageSize).toBe(37);
  expect(readConfig(resolveControls(file(), {}, {}, { ISHARES_STORE_RAW_DOWNLOADS: 'yes' })).storeRawDownloads).toBe(true);
});

test('config: resolver rejects unknown, invalid and environment-file injection values', () => {
  for (const value of [{ UNKNOWN: 1 }, { TICKERS: 'IVV\nEVIL=yes' }, { CONCURRENCY: 0 }, { TER: '1' }, { SEC_YIELD: '1:2:3' }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { STORE_RAW_DOWNLOADS: 'maybe' }, { AUM: '1:2:3' }, { PERFORMANCE_1Y: '5' }, { TICKERS: ['IVV'] }, { OUTPUT_DIR: '/tmp/x' }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { TICKERS: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { ISHARES_TICKERS: 'x\0bad' })).toThrow();
  expect(() => resolveControls({}, [])).toThrow();
});

test('config: config file defaults: every control, provider values, scheduled path equals defaults', async () => {
  expect(Object.keys(file()).sort()).toEqual([...CONTROL_NAMES].sort());
  for (const value of Object.values(file())) expect(typeof value).toBe('string');
  const config = readConfig(resolveControls(file()));
  expect(config.tickers).toEqual([]); expect(config.maxFetches).toBe(0); expect(config.requestSleepSeconds).toBe(0);
  expect(config.concurrency).toBe(4); expect(config.holdingsPageSize).toBe(250); expect(config.historyPageSize).toBe(1000);
  expect(config.maxRetries).toBe(2); expect(config.storeRawDownloads).toBe(false);
  expect(config.aumRange).toBeUndefined(); expect(config.terRange).toBeUndefined(); expect(config.secYieldRange).toBeUndefined(); expect(config.dividendYieldRange).toBeUndefined();
  expect(config.performanceRanges).toEqual({}); expect(config.totalReturnRanges).toEqual({});
  // scheduled run: empty advanced and inputs, no protected variables
  expect(resolveControls(file(), JSON.parse('{}'), {}, {})).toEqual(resolveControls(file()));
  // runtime path reads the same file
  expect(await runtimeControls({})).toEqual(resolveControls(file()));
  expect((await runtimeControls({ TICKERS: 'IVV' })).TICKERS).toBe('IVV');
});

test('config: controls, config file, --help and README are in sync', async () => {
  const doc = read('README.md');
  const help = read('scripts/update-data.ts');
  for (const name of CONTROL_NAMES) {
    const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
    expect(doc).toContain(tenor ? '`_' + tenor[2] + '`' : '`' + name + '`');
    if (tenor) expect(doc).toContain('`' + tenor[1] + '_YTD`');
    expect(help).toContain(`  ${name}=`);
  }
  expect(doc).toContain('scripts/update-data.config.json');
  const rows = [...doc.slice(doc.indexOf('### Update controls'), doc.indexOf('### Examples')).matchAll(/^\| `(\w+)`/gm)].map((m) => m[1]);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(CONTROL_NAMES.some((name) => name === row || name.startsWith(`${row}_`))).toBe(true);
});

test('workflow: scheduled, advanced JSON, one shared resolver, fixed output directory', () => {
  const inputsBlock = workflow.slice(workflow.indexOf('    inputs:'), workflow.indexOf('\npermissions:'));
  const names = [...inputsBlock.matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
  expect(names.length).toBeLessThanOrEqual(25); expect(names).toContain('advanced');
  expect(inputsBlock).toContain("default: '{}'");
  for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase());
  expect(workflow).toContain("cron: '0 0 * * 0'"); expect(workflow).not.toMatch(/^  push:/m);
  expect(workflow).toContain('toJSON(inputs)'); expect(workflow).toContain('resolveControls');
  expect(workflow).not.toMatch(/\$\{\{\s*(github\.event\.)?inputs\./);
  expect(workflow).not.toMatch(/OUTPUT_DIR/);
  expect(workflow).toContain('git add api/ishares\n'); expect(workflow).not.toMatch(/git add (?!api\/ishares\b)/);
  expect(workflow).toContain('if: ${{ !cancelled() }}');
});

test("TER filter uses net expense ratio, falls back to gross, rejects unavailable", () => {
  const config = readConfig(resolveControls({ TER: ":0.1" }));
  expect(catalogFilterReasons(fund, config)).toEqual([]);
  expect(catalogFilterReasons({ ...fund, netExpenseRatio: "0.50" }, config)).toEqual(["expense ratio range"]);
  expect(catalogFilterReasons({ ...fund, netExpenseRatio: "—", grossExpenseRatio: "0.05" }, config)).toEqual([]);
  expect(catalogFilterReasons({ ...fund, netExpenseRatio: "—", grossExpenseRatio: "—" }, config)).toEqual(["expense ratio unavailable"]);
});

test("README structure and workflow resolver stay consistent", () => {
  const doc = read("README.md");
  const headings = [...doc.matchAll(/^#{1,3} .+$/gm)].map((m) => m[0]);
  for (const heading of ["## Using Bun", "### Data sources", "### Metrics and caveats", "### Update controls", "### Examples", "## TypeScript and verification", "## License"]) {
    expect(headings).toContain(heading);
  }
  expect(doc).not.toMatch(/worklog|fixtures|config-docs/i);
  expect(read("scripts/update-data.ts")).toContain('/// <reference types="node" />');
});

describe("system CA", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const noReexec = () => { throw new Error("reexec"); };

  test("USE_SYSTEM_CA resolver: auto/true/false case-insensitive, rejects others, default auto", () => {
    expect(resolveControls(file()).USE_SYSTEM_CA).toBe("auto");
    for (const mode of ["auto", "true", "false", "TRUE", "Auto"]) {
      expect(resolveControls(file(), { USE_SYSTEM_CA: mode }).USE_SYSTEM_CA).toBe(mode.toLowerCase());
    }
    expect(() => resolveControls(file(), { USE_SYSTEM_CA: "maybe" })).toThrow();
    expect(() => resolveControls(file(), {}, {}, { USE_SYSTEM_CA: "maybe" })).toThrow();
  });

  test("isCertError detects certificate errors, including causes", () => {
    expect(isCertError({ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" })).toBe(true);
    expect(isCertError(new Error("unable to get local issuer certificate"))).toBe(true);
    expect(isCertError(Object.assign(new Error("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }))).toBe(true);
    expect(isCertError({ code: "ECONNRESET" })).toBe(false);
    expect(isCertError(new Error("HTTP 403"))).toBe(false);
  });

  test("installSystemCa leaves fetch alone for mode false or an already active store", () => {
    installSystemCa("false", noReexec, false);
    expect(globalThis.fetch).toBe(realFetch);
    installSystemCa("auto", noReexec, true);
    expect(globalThis.fetch).toBe(realFetch);
  });

  test("installSystemCa mode true restarts immediately", () => {
    let calls = 0;
    installSystemCa("true", (() => { calls++; return undefined as never; }), false);
    expect(calls).toBe(1);
  });

  test("installSystemCa mode auto restarts once on a cert error only", async () => {
    let calls = 0;
    const reexec = (() => { calls++; return undefined as never; });
    let failure: unknown = Object.assign(new Error("fetch failed"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" });
    globalThis.fetch = (async () => { if (failure) throw failure; return new Response("ok"); }) as typeof fetch;
    installSystemCa("auto", reexec, false);
    expect(globalThis.fetch).not.toBe(realFetch);
    await globalThis.fetch("https://example.test");
    expect(calls).toBe(1);
    failure = new Error("ECONNRESET");
    await expect(globalThis.fetch("https://example.test")).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(1);
    failure = null;
    expect(await (await globalThis.fetch("https://example.test")).text()).toBe("ok");
    expect(calls).toBe(1);
  });
});

describe("standard feed shapes", () => {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const performanceRows: Array<Record<string, string>> = [];
  for (let year = 2015; year <= 2024; year++) {
    for (let month = 0; month < 12; month++) {
      performanceRows.push({ Date: `${months[month]} 28, ${year}`, Return: "1" });
    }
  }
  const returns = deriveReturnMetrics({ headers: ["Date", "Return"], rows: performanceRows });
  const distributionSheet = {
    headers: ["Record Date", "Ex-Date", "Payable Date", "Total Distribution"],
    rows: [
      { "Record Date": "Mar 17, 2026", "Ex-Date": "Mar 17, 2026", "Payable Date": "Mar 20, 2026", "Total Distribution": "1.78" },
      { "Record Date": "Jun 15, 2026", "Ex-Date": "Jun 15, 2026", "Payable Date": "Jun 18, 2026", "Total Distribution": "2.00" },
    ],
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
    distributionSheet,
    holdings: manifest(508),
    history: manifest(6637),
    download: "https://example.test/download",
    fundHeader: "https://example.test/header",
  };

  test("dates: ISO and the display form used by the sibling feeds", () => {
    expect(isoDate("Jun 30, 2026")).toBe("2026-06-30");
    expect(isoDate("Jun 3 2026")).toBe("2026-06-03");
    expect(displayDate("Jun 30, 2026")).toBe("Jun 30 2026");
    expect(isoDate("—")).toBeNull();
    expect(isoDate("")).toBeNull();
    expect(displayDate(undefined)).toBeNull();
  });

  test("metrics map cumulative to tr*, annualized to cagr*, and never invent zeros", () => {
    const metrics = buildMetrics(returns, 1.06, 0.94);
    expect(Object.keys(metrics)).toEqual([
      "ytd", "tr1y", "tr3y", "tr5y", "tr10y", "cagr3y", "cagr5y", "cagr10y", "siAnn",
      "dividendYield", "dividendYieldText", "secYield", "secYieldText", "returnsBasis", "performanceAsOf",
    ]);
    expect(metrics.tr3y).toBeCloseTo((1.01 ** 36 - 1) * 100, 6);
    expect(metrics.cagr3y).toBeCloseTo((1.01 ** 12 - 1) * 100, 6);
    expect(metrics.performanceAsOf).toBe("2024-12-28");
    expect(metrics.returnsBasis).toBe(RETURNS_BASIS);
    expect(metrics.dividendYieldText).toBe("1.06%");
    const young = buildMetrics(deriveReturnMetrics({ headers: ["Date", "Return"], rows: performanceRows.slice(-12) }), null, null);
    expect([young.tr3y, young.tr5y, young.tr10y, young.cagr3y, young.dividendYield, young.secYield]).toEqual([null, null, null, null, null, null]);
    expect(young.secYieldText).toBe("—");
    const none = buildMetrics(deriveReturnMetrics(undefined), null, null);
    expect(none.ytd).toBeNull();
    expect(none.performanceAsOf).toBeNull();
  });

  test("index row and meta use the standard layout", () => {
    const { row, meta } = buildStandardFund(facts);
    expect(Object.keys(row).slice(0, 9)).toEqual(["ticker", "name", "category", "fundPage", "dataFile", "cusip", "isin", "ter", "terValue"]);
    expect(row).toMatchObject({
      ticker: "IVV",
      category: "Equity",
      dataFile: "./funds/IVV/meta.json",
      cusip: "464287200",
      isin: "US4642872000",
      ter: "0.03%",
      terValue: 0.03,
      nav: "$767.13",
      aum: "$700.00 B",
      aumValue: 700_000_000_000,
      asOfDate: "Oct 01 2026",
      inceptionDate: "May 15 2000",
      holdings: 508,
      history: 6637,
    });
    expect(row.distributions).toEqual({ frequency: "Quarterly", exDate: "06/15/2026", dividend: "2.00" });
    expect(row.returns.monthEnd.yr3).toBeCloseTo((1.01 ** 12 - 1) * 100, 6);
    expect(row.returns.monthEnd.asOfDate).toBe("Dec 28 2024");
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
    expect(meta.distributions.rows[0]).toEqual(["Mar 17, 2026", "Mar 17, 2026", "Mar 20, 2026", "1.78"]);
    expect(meta.holdings.pages).toEqual(["./holdings/001.json"]);
    expect(meta.yields.secYieldKind).toContain("Aug 31, 2026");
  });

  test("a fund without a download is a catalog row with empty metrics and no data file", () => {
    const row = buildCatalogRow(fund);
    expect(row.dataFile).toBeNull();
    expect(row.holdings).toBe(0);
    expect(row.history).toBe(0);
    expect(row.category).toBe("ETF");
    expect(row.metrics.tr1y).toBeNull();
    expect(row.metrics.dividendYield).toBe(1.25);
    expect(row.aumValue).toBe(700_000_000_000);
    expect(feedCounts([row, buildStandardFund(facts).row])).toEqual({ funds: 2, holdings: 508, history: 6637 });
  });

  test("a published row is turned back into the catalog entry the filters read", () => {
    const back = catalogFundFromRow(buildStandardFund(facts).row);
    expect(back).toMatchObject({ ticker: "IVV", portfolioId: "239726", netExpenseRatio: "0.03", grossExpenseRatio: "0.03" });
    expect(back.netAssets).toBe("700000000000");
    expect(catalogFilterReasons(back, readConfig({ AUM: "large:", TER: ":0.05", DIVIDEND_YIELD: "1:2" }))).toEqual([]);
    const legacy = { ...fund, dataFile: "./funds/IVV/meta.json" };
    expect(catalogFundFromRow(legacy)).toBe(legacy);
  });

  test("category: product header first, holdings market-value mix as the fallback", () => {
    const holding = (assetClass: string, value: number) => ({ "Asset Class": assetClass, "Market Value": String(value) });
    expect(normalizeAssetClass("Multi Asset")).toBe("Multi-asset");
    expect(normalizeAssetClass(" Fixed  Income ")).toBe("Fixed Income");
    expect(normalizeAssetClass("-")).toBeNull();
    expect(deriveAssetClass([holding("Equity", 98), holding("Cash", 50), holding("Futures", 5)])).toBe("Equity");
    expect(deriveAssetClass([holding("Equity", 60), holding("Fixed Income", 40)])).toBe("Multi-asset");
    expect(deriveAssetClass([holding("Fixed Income", 90), holding("Money Market", 40), holding("Equity", 1)])).toBe("Fixed Income");
    expect(deriveAssetClass([holding("Money Market", 95), holding("Fixed Income", 5)])).toBe("Money Market");
    expect(deriveAssetClass([holding("Cash", 100)])).toBe("ETF");
    expect(deriveAssetClass([])).toBe("ETF");
  });

  test("fund header gives asset class and ISIN; CUSIP comes from a US ISIN", () => {
    const header = {
      componentsByNameMap: { fundHeader: { containersByNameMap: { fundName: { dataPointsByNameMap: {
        assetClass: { value: "Multi Asset" },
        productIsin: { value: "US4642898674" },
      } } } } },
    };
    expect(parseFundHeader(header)).toEqual({ secYield: null, assetClass: "Multi-asset", isin: "US4642898674" });
    expect(parseFundHeader({})).toEqual({ secYield: null, assetClass: null, isin: null });
    expect(parseFundHeader({ componentsByNameMap: { fundHeader: { containersByNameMap: { fundName: { dataPointsByNameMap: { productIsin: { value: "-" } } } } } } }).isin).toBeNull();
    expect(cusipFromIsin("US4642898674")).toBe("464289867");
    expect(cusipFromIsin("IE00B4L5Y983")).toBeNull();
    expect(cusipFromIsin(null)).toBeNull();
  });

  test("distribution frequency labels carry payments per year", () => {
    expect(frequencyInfo("01 - Monthly")).toEqual({ label: "Monthly", paymentsPerYear: 12 });
    expect(frequencyInfo("06 - Semi-annually")).toEqual({ label: "Semi-annually", paymentsPerYear: 2 });
    expect(frequencyInfo("99 - Irregular")).toEqual({ label: "Irregular", paymentsPerYear: null });
    expect(frequencyInfo("00 - None")).toEqual({ label: "None", paymentsPerYear: null });
  });
});
