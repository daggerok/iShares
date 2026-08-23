/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  catalogFilterReasons,
  deriveReturnMetrics,
  parseAumRange,
  parseRange,
  readConfig,
  returnFilterReasons,
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
  test("requires a colon in every non-empty numeric range", () => {
    expect(parseRange("")).toBeUndefined();
    expect(parseRange(":")).toBeUndefined();
    expect(parseRange(":900000")).toEqual({ min: undefined, max: 900000 });
    expect(parseRange("12345678:123456789")).toEqual({
      min: 12345678,
      max: 123456789,
    });
    expect(parseRange("1234567:")).toEqual({ min: 1234567, max: undefined });
    expect(parseRange("-10%:12.5%")).toEqual({ min: -10, max: 12.5 });
    expect(() => parseRange("123456789")).toThrow("exactly one colon");
    expect(() => parseRange("1:2:3")).toThrow("exactly one colon");
    expect(() => parseRange("20:5")).toThrow("minimum cannot exceed");
  });

  test("accepts numeric and preset AUM range bounds", () => {
    expect(parseAumRange("")).toBeUndefined();
    expect(parseAumRange(":")).toBeUndefined();
    expect(parseAumRange(":900000")).toEqual({
      min: undefined,
      max: 900000,
      maxExclusive: false,
      source: ":900000",
    });
    expect(parseAumRange("12345678:123456789")).toEqual({
      min: 12345678,
      max: 123456789,
      maxExclusive: false,
      source: "12345678:123456789",
    });
    expect(parseAumRange("1234567:")).toEqual({
      min: 1234567,
      max: undefined,
      maxExclusive: false,
      source: "1234567:",
    });
    expect(parseAumRange("micro:small")).toEqual({
      min: 10_000_000,
      max: 2_000_000_000,
      maxExclusive: true,
      source: "micro:small",
    });
    expect(parseAumRange("large:")).toEqual({
      min: 10_000_000_000,
      max: undefined,
      maxExclusive: false,
      source: "large:",
    });
  });

  test("rejects colonless and invalid AUM ranges", () => {
    for (const value of ["123456789", "mid", "all"]) {
      expect(() => parseAumRange(value)).toThrow("exactly one colon");
    }
    expect(() => parseAumRange("all:")).toThrow("USD amount");
    expect(() => parseAumRange("large:micro")).toThrow("cannot reach or exceed");
  });

  test("supports the combined AUM and dividend-yield settings", () => {
    const config = readConfig({
      ISHARES_LIMIT: "3",
      TICKERS: "ivv, DGRO;DVY IVV",
      AUM: "300M:2B",
      DIVIDEND_YIELD: "1%:4.5%",
      PERFORMANCE_3Y: "5:20",
      TOTAL_RETURN_10Y: ":300",
      ISHARES_STORE_RAW_DOWNLOADS: "yes",
    });
    expect(config.maxFetches).toBe(3);
    expect(config.tickers).toEqual(["IVV", "DGRO", "DVY"]);
    expect(config.aumRange).toMatchObject({ min: 300_000_000, max: 2_000_000_000 });
    expect(config.dividendYieldRange).toEqual({ min: 1, max: 4.5 });
    expect(config.performanceRanges["3Y"]).toEqual({ min: 5, max: 20 });
    expect(config.totalReturnRanges["10Y"]).toEqual({ min: undefined, max: 300 });
    expect(config.storeRawDownloads).toBe(true);
    expect(config.maxRetries).toBe(2);
  });
});

describe("catalog filters", () => {
  test("combines ticker, AUM, and dividend yield with AND logic", () => {
    expect(
      catalogFilterReasons(
        { ...fund, netAssets: "1,500,000,000" },
        readConfig({
          TICKERS: "IVV DGRO",
          AUM: "micro:small",
          DIVIDEND_YIELD: "1:2",
        }),
      ),
    ).toEqual([]);
  });

  test("uses exclusive preset maxima and inclusive numeric maxima", () => {
    const atTwoBillion = { ...fund, netAssets: "2,000,000,000" };
    expect(catalogFilterReasons(atTwoBillion, readConfig({ AUM: "micro:small" }))).toContain(
      "maximum AUM",
    );
    expect(catalogFilterReasons(atTwoBillion, readConfig({ AUM: "1B:2B" }))).toEqual([]);
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
