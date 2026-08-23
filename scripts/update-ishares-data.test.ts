/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  catalogFilterReasons,
  deriveReturnMetrics,
  paginationPaths,
  parseAumRange,
  parseRange,
  readConfig,
  returnFilterReasons,
  selectUpdateBatch,
} from "./update-ishares-data";

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
