/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CONTROL_NAMES,
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
