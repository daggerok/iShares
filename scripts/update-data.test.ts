/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  catalogFilterReasons,
  deriveReturnMetrics,
  deriveDistributionFrequency,
  paginationPaths,
  parseAumRange,
  parseRange,
  parseSecYield,
  parseWorkbook,
  readConfig,
  returnFilterReasons,
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


import { test as frequencyLabelTest, expect as frequencyLabelExpect } from 'bun:test';
frequencyLabelTest('missing frequency uses None in generated labels and UI fallback', async () => {
  const updater = await import('./update-data');
  frequencyLabelExpect(updater.deriveDistributionFrequency()).toBe('00 - None');
  frequencyLabelExpect(updater.deriveDistributionFrequency({ headers: ['Ex-Date'], rows: [] } as any)).toBe('00 - None');
  const html = await Bun.file(new URL('../index.html', import.meta.url)).text();
  frequencyLabelExpect(html).toContain('Frequency: fund.distributions?.frequencyCode || "00 - None"');
});


import { test as headerTest, expect as headerExpect } from 'bun:test';
async function headerSummaryHarness() {
  const source = await Bun.file(new URL('../index.html', import.meta.url)).text();
  const match = /^([ \t]*)function renderHeaderSummary\(/m.exec(source);
  headerExpect(match).not.toBeNull();
  const tail = source.slice(match!.index);
  const end = new RegExp('^' + match![1] + '}', 'm').exec(tail)!;
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(tail.slice(0, end.index + end[0].length));
  const makeNode = (text = ''): any => {
    const node: any = { textContent: text, childNodes: [], dataset: {}, listeners: {} };
    node.replaceChildren = (...children: any[]) => { node.childNodes = children; };
    node.append = (...children: any[]) => { node.childNodes.push(...children); };
    node.addEventListener = (name: string, listener: any) => { node.listeners[name] = listener; };
    return node;
  };
  const panel = makeNode(), subtitle = makeNode(), details = makeNode('Data: source link and updated timestamp');
  subtitle.append(details);
  const document = { getElementById: () => panel, createTextNode: makeNode, createElement: () => makeNode() };
  const render = new Function('document', js + '; return renderHeaderSummary;')(document);
  const text = () => subtitle.childNodes.map((n: any) => n.textContent).join('');
  return { render, panel, subtitle, details, makeNode, text };
}
headerTest('header has no visible subtitle without selection; original details nodes are retained', async () => {
  const h = await headerSummaryHarness();
  h.render(h.subtitle, new Set(), null, () => {});
  headerExpect(h.text()).toBe('');
  headerExpect(h.panel.childNodes).toEqual([h.details]);
  headerExpect(h.panel.childNodes[0]).toBe(h.details);
});
headerTest('header shows sorted selected tickers only, preserving click activation and highlight', async () => {
  const h = await headerSummaryHarness(); const activated: string[] = [];
  h.render(h.subtitle, new Set(['ZZZ', 'AAA']), 'AAA', (ticker: string) => activated.push(ticker));
  headerExpect(h.text()).toBe('2 selected: AAA, ZZZ');
  const links = h.subtitle.childNodes.filter((n: any) => n.dataset.headerFund);
  headerExpect(links[0].className).toContain('underline');
  links[1].listeners.click({ preventDefault() {} });
  headerExpect(activated).toEqual(['ZZZ']);
  headerExpect(h.panel.childNodes[0]).toBe(h.details);
});
headerTest('all selected still lists tickers; clear replaces both summary and selection', async () => {
  const h = await headerSummaryHarness();
  h.render(h.subtitle, new Set(['CCC','AAA','BBB']), 'BBB', () => {});
  headerExpect(h.text()).toBe('3 selected: AAA, BBB, CCC');
  const next = h.makeNode('Fresh detail context'); h.subtitle.replaceChildren(next);
  h.render(h.subtitle, new Set(), null, () => {});
  headerExpect(h.text()).toBe(''); headerExpect(h.panel.childNodes).toEqual([next]);
});
headerTest('header markup supplies a focusable counter and hidden rich panel with dismissal', async () => {
  const html = await Bun.file(new URL('../index.html', import.meta.url)).text();
  headerExpect(html).toMatch(/<button[^>]*aria-controls="app-summary"[^>]*id="ticker-count"/);
  headerExpect(html).toContain('id="app-summary" role="region" aria-label="ETF catalog information" hidden');
  headerExpect(html).toContain("event.key !== 'Escape'");
  headerExpect(html).toContain("trigger.addEventListener('focus', show)");
  headerExpect(html).toContain("trigger.addEventListener('pointerenter'");
});
