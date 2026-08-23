#!/usr/bin/env bun
/// <reference types="node" />
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";

const ROOT = new URL("../api/ishares/", import.meta.url);
const RAW = new URL("../api/ishares/raw/", import.meta.url);
const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const AUM_PRESETS = new Set(["all", "nano", "micro", "small", "mid", "large"]);
export const RETURN_PERIODS = ["YTD", "1Y", "3Y", "5Y", "10Y"] as const;
type ReturnPeriod = (typeof RETURN_PERIODS)[number];

type Range = { min?: number; max?: number };
type RangeMap = Partial<Record<ReturnPeriod, Range>>;
type MetricMap = Record<ReturnPeriod, number | null>;

type Fund = {
  ticker: string;
  portfolioId: string;
  name: string;
  fundPage: string;
  trailingYield: string;
  yieldAsOf: string;
  ytdReturn: string;
  returnAsOf: string;
  inceptionDate: string;
  grossExpenseRatio: string;
  netExpenseRatio: string;
  netAssets: string;
  type: string;
  [key: string]: unknown;
};

type Sheet = {
  headers: string[];
  rows: Array<Record<string, string>>;
};

type ReturnMetrics = {
  asOfDate: string;
  performance: MetricMap;
  totalReturn: MetricMap;
};

type PageManifest = {
  totalRows: number;
  pageSize: number;
  pageCount: number;
  pages: string[];
};

export type UpdaterConfig = {
  maxFetches: number;
  requestSleepSeconds: number;
  minAum?: number;
  maxAum?: number;
  aumPreset: string;
  concurrency: number;
  holdingsPageSize: number;
  historyPageSize: number;
  storeRawDownloads: boolean;
  maxRetries: number;
  tickers: string[];
  minDividendYield?: number;
  maxDividendYield?: number;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

type UpdateResult = {
  ticker: string;
  status: "updated" | "unchanged" | "filtered" | "failed";
  changed?: boolean;
  reason?: string;
  indexFields?: Record<string, unknown>;
};

const esc = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function envValue(
  env: Record<string, string | undefined>,
  name: string,
  aliases: string[] = [],
) {
  for (const key of [name, `ISHARES_${name}`, ...aliases]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return "";
}

function parseDataNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[$,%\s,]/g, "");
  if (!normalized || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseConfigNumber(value: string, name: string) {
  const parsed = parseDataNumber(value);
  if (parsed === null) throw Error(`${name} must be a number; received ${JSON.stringify(value)}`);
  return parsed;
}

function parseAum(value: string, name: string) {
  const normalized = value.replace(/[$,\s]/g, "").toUpperCase();
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([KMBT])?$/);
  if (!match) {
    throw Error(`${name} must be a USD amount such as 300M or 2000000000; received ${JSON.stringify(value)}`);
  }
  const multipliers: Record<string, number> = {
    "": 1,
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
    T: 1_000_000_000_000,
  };
  return Number(match[1]) * multipliers[match[2] || ""];
}

function parseInteger(value: string, name: string, fallback: number, minimum: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw Error(`${name} must be an integer >= ${minimum}; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Parse an inclusive percentage range. A single number is a minimum.
 * Examples: "5:20", "5:", ":20", "5".
 */
export function parseRange(value: string, name = "range"): Range | undefined {
  const input = value.trim();
  if (!input) return undefined;
  const parts = input.split(":");
  if (parts.length > 2) {
    throw Error(`${name} must use min:max syntax; received ${JSON.stringify(value)}`);
  }
  if (parts.length === 1) return { min: parseConfigNumber(parts[0], name) };
  const min = parts[0].trim() ? parseConfigNumber(parts[0], name) : undefined;
  const max = parts[1].trim() ? parseConfigNumber(parts[1], name) : undefined;
  if (min === undefined && max === undefined) {
    throw Error(`${name} must provide a minimum, a maximum, or both`);
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw Error(`${name} minimum cannot exceed its maximum`);
  }
  return { min, max };
}

function parseRanges(
  env: Record<string, string | undefined>,
  prefix: "PERFORMANCE" | "TOTAL_RETURN",
) {
  const ranges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const range = parseRange(envValue(env, `${prefix}_${period}`), `${prefix}_${period}`);
    if (range) ranges[period] = range;
  }
  return ranges;
}

export function readConfig(
  env: Record<string, string | undefined> = process.env,
): UpdaterConfig {
  const minAumValue = envValue(env, "MIN_AUM");
  const maxAumValue = envValue(env, "MAX_AUM");
  const minYieldValue = envValue(env, "MIN_DIVIDEND_YIELD");
  const maxYieldValue = envValue(env, "MAX_DIVIDEND_YIELD");
  const aumPreset = (envValue(env, "AUM_PRESET") || "all").toLowerCase();
  if (!AUM_PRESETS.has(aumPreset)) {
    throw Error(`AUM_PRESET must be one of ${[...AUM_PRESETS].join(", ")}; received ${JSON.stringify(aumPreset)}`);
  }

  const config: UpdaterConfig = {
    maxFetches: parseInteger(
      envValue(env, "MAX_FETCHES", ["ISHARES_LIMIT"]),
      "MAX_FETCHES",
      0,
      0,
    ),
    requestSleepSeconds: envValue(env, "REQUEST_SLEEP")
      ? parseConfigNumber(envValue(env, "REQUEST_SLEEP"), "REQUEST_SLEEP")
      : 0,
    minAum: minAumValue ? parseAum(minAumValue, "MIN_AUM") : undefined,
    maxAum: maxAumValue ? parseAum(maxAumValue, "MAX_AUM") : undefined,
    aumPreset,
    concurrency: parseInteger(envValue(env, "CONCURRENCY"), "CONCURRENCY", 4, 1),
    holdingsPageSize: parseInteger(
      envValue(env, "HOLDINGS_PAGE_SIZE"),
      "HOLDINGS_PAGE_SIZE",
      250,
      1,
    ),
    historyPageSize: parseInteger(
      envValue(env, "HISTORY_PAGE_SIZE", ["HISTORICAL_PAGE_SIZE"]),
      "HISTORY_PAGE_SIZE",
      1_000,
      1,
    ),
    storeRawDownloads: TRUTHY.has(
      envValue(env, "STORE_RAW_DOWNLOADS", ["ISHARES_STORE_RAW_DOWNLOADS"]).toLowerCase(),
    ),
    maxRetries: parseInteger(envValue(env, "MAX_RETRIES"), "MAX_RETRIES", 2, 0),
    tickers: [
      ...new Set(
        envValue(env, "TICKERS")
          .toUpperCase()
          .split(/[\s,;]+/)
          .map((ticker) => ticker.trim())
          .filter(Boolean),
      ),
    ],
    minDividendYield: minYieldValue
      ? parseConfigNumber(minYieldValue, "MIN_DIVIDEND_YIELD")
      : undefined,
    maxDividendYield: maxYieldValue
      ? parseConfigNumber(maxYieldValue, "MAX_DIVIDEND_YIELD")
      : undefined,
    performanceRanges: parseRanges(env, "PERFORMANCE"),
    totalReturnRanges: parseRanges(env, "TOTAL_RETURN"),
  };

  if (config.requestSleepSeconds < 0) throw Error("REQUEST_SLEEP must be >= 0");
  if (config.minAum !== undefined && config.maxAum !== undefined && config.minAum > config.maxAum) {
    throw Error("MIN_AUM cannot exceed MAX_AUM");
  }
  if (
    config.minDividendYield !== undefined &&
    config.maxDividendYield !== undefined &&
    config.minDividendYield > config.maxDividendYield
  ) {
    throw Error("MIN_DIVIDEND_YIELD cannot exceed MAX_DIVIDEND_YIELD");
  }
  return config;
}

function inRange(value: number, range: Range) {
  return !(
    (range.min !== undefined && value < range.min) ||
    (range.max !== undefined && value > range.max)
  );
}

function presetMatches(aum: number, preset: string) {
  if (preset === "nano") return aum < 10_000_000;
  if (preset === "micro") return aum >= 10_000_000 && aum < 300_000_000;
  if (preset === "small") return aum >= 300_000_000 && aum < 2_000_000_000;
  if (preset === "mid") return aum >= 2_000_000_000 && aum < 10_000_000_000;
  if (preset === "large") return aum >= 10_000_000_000;
  return true;
}

/** Return all catalog-only reasons why a fund is not eligible. */
export function catalogFilterReasons(fund: Fund, config: UpdaterConfig) {
  const reasons: string[] = [];
  if (config.tickers.length && !config.tickers.includes(fund.ticker.toUpperCase())) {
    reasons.push("ticker");
  }

  const hasAumFilter =
    config.aumPreset !== "all" || config.minAum !== undefined || config.maxAum !== undefined;
  if (hasAumFilter) {
    const aum = parseDataNumber(fund.netAssets);
    if (aum === null) reasons.push("AUM unavailable");
    else {
      if (!presetMatches(aum, config.aumPreset)) reasons.push(`AUM preset ${config.aumPreset}`);
      if (config.minAum !== undefined && aum < config.minAum) reasons.push("minimum AUM");
      if (config.maxAum !== undefined && aum > config.maxAum) reasons.push("maximum AUM");
    }
  }

  const hasYieldFilter =
    config.minDividendYield !== undefined || config.maxDividendYield !== undefined;
  if (hasYieldFilter) {
    const dividendYield = parseDataNumber(fund.trailingYield);
    if (dividendYield === null) reasons.push("dividend yield unavailable");
    else {
      if (
        config.minDividendYield !== undefined &&
        dividendYield < config.minDividendYield
      ) {
        reasons.push("minimum dividend yield");
      }
      if (
        config.maxDividendYield !== undefined &&
        dividendYield > config.maxDividendYield
      ) {
        reasons.push("maximum dividend yield");
      }
    }
  }
  return reasons;
}

/**
 * Return all post-download return-filter failures. Missing return data passes,
 * which keeps young funds when they do not yet have a requested history period.
 */
export function returnFilterReasons(metrics: ReturnMetrics, config: UpdaterConfig) {
  const reasons: string[] = [];
  for (const period of RETURN_PERIODS) {
    const performanceRange = config.performanceRanges[period];
    const performance = metrics.performance[period];
    if (performanceRange && performance !== null && !inRange(performance, performanceRange)) {
      reasons.push(`PERFORMANCE_${period}=${performance}`);
    }
    const totalReturnRange = config.totalReturnRanges[period];
    const totalReturn = metrics.totalReturn[period];
    if (totalReturnRange && totalReturn !== null && !inRange(totalReturn, totalReturnRange)) {
      reasons.push(`TOTAL_RETURN_${period}=${totalReturn}`);
    }
  }
  return reasons;
}

class HttpError extends Error {
  constructor(
    public status: number,
    public retryAfterMilliseconds: number | null,
    url: string,
  ) {
    super(`${status} ${url}`);
  }
}

function retryAfterMilliseconds(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function retryable(error: unknown) {
  if (!(error instanceof HttpError)) return true;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

function createRequestGate(seconds: number) {
  const interval = seconds * 1_000;
  let nextStart = 0;
  let tail = Promise.resolve();
  return () => {
    const turn = tail.then(async () => {
      const wait = Math.max(0, nextStart - Date.now());
      if (wait) await sleep(wait);
      nextStart = Date.now() + interval;
    });
    tail = turn.catch(() => undefined);
    return turn;
  };
}

async function requestText(
  url: string,
  label: string,
  config: UpdaterConfig,
  waitForRequest: () => Promise<void>,
) {
  const attempts = config.maxRetries + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await waitForRequest();
    try {
      console.log(`[fetch] ${label} attempt=${attempt}/${attempts}`);
      const response = await fetch(url, {
        headers: { accept: "text/html,application/xml,*/*" },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        throw new HttpError(
          response.status,
          retryAfterMilliseconds(response.headers.get("retry-after")),
          url,
        );
      }
      return await response.text();
    } catch (error) {
      if (attempt === attempts || !retryable(error)) throw error;
      const retryAfter = error instanceof HttpError ? error.retryAfterMilliseconds : null;
      const backoff = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      const delay = Math.min(60_000, Math.max(backoff, retryAfter || 0));
      console.warn(
        `[retry] ${label} in=${Math.round(delay / 1_000)}s reason=${String(error)}`,
      );
      await sleep(delay);
    }
  }
  throw Error(`unreachable fetch state for ${label}`);
}

async function old(url: URL) {
  try {
    return await readFile(url, "utf8");
  } catch {
    return "";
  }
}

async function put(url: URL, contents: string) {
  if ((await old(url)) === contents) return false;
  await mkdir(new URL("./", url), { recursive: true });
  await writeFile(url, contents);
  return true;
}

export function parseCatalog(html: string) {
  const output: Fund[] = [];
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    const match = row.match(
      /href="(\/us\/products\/(\d+)\/[^"?]+)"[^>]*>([A-Z0-9]{1,10})<\/a>/,
    );
    if (!match || !/\b(ETF|Trust)\b/i.test(row)) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
      esc(
        cell[1]
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    );
    output.push({
      ticker: match[3],
      portfolioId: match[2],
      name: cells[1] || match[3],
      fundPage: `https://www.ishares.com${match[1]}`,
      trailingYield: cells[2] || "—",
      yieldAsOf: cells[3] || "—",
      ytdReturn: cells[4] || "—",
      returnAsOf: cells[5] || "—",
      inceptionDate: cells[6] || "—",
      grossExpenseRatio: cells[7] || "—",
      netExpenseRatio: cells[8] || "—",
      netAssets: cells[9] || "—",
      type: "iShares ETF",
    });
  }
  return output;
}

export function parseWorkbook(xml: string) {
  const sheets: Record<string, Sheet> = {};
  for (const match of xml.matchAll(
    /<ss:Worksheet[^>]*ss:Name="([^"]+)"[\s\S]*?>([\s\S]*?)<\/ss:Worksheet>/gi,
  )) {
    const rows = [...match[2].matchAll(/<ss:Row[\s\S]*?<\/ss:Row>/gi)]
      .map((row) =>
        [...row[0].matchAll(/<ss:Data[^>]*>([\s\S]*?)<\/ss:Data>/gi)].map((data) =>
          esc(data[1].replace(/<[^>]+>/g, "").trim()),
        ),
      )
      .filter((row) => row.some(Boolean));
    if (!rows.length) continue;
    let headerIndex = rows.findIndex((row) => row.some((value) => /^ticker$/i.test(value)));
    if (headerIndex < 0) headerIndex = rows.findIndex((row) => row.length > 1);
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex].map((value, index) => value || `Column ${index + 1}`);
    sheets[match[1]] = {
      headers,
      rows: rows
        .slice(headerIndex + 1)
        .filter((row) => row.some(Boolean))
        .map((row) =>
          Object.fromEntries(headers.map((header, index) => [header, row[index] || ""])),
        ),
    };
  }
  return sheets;
}

function emptyMetrics(): MetricMap {
  return { YTD: null, "1Y": null, "3Y": null, "5Y": null, "10Y": null };
}

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Derive quarter-end official-style NAV CAGR and cumulative total return metrics. */
export function deriveReturnMetrics(performance?: Sheet): ReturnMetrics {
  const missing = {
    asOfDate: "",
    performance: emptyMetrics(),
    totalReturn: emptyMetrics(),
  };
  if (!performance || performance.headers.length < 2) return missing;
  const dateHeader = performance.headers[0];
  const valueHeader = performance.headers[1];
  const monthly = new Map<
    number,
    { month: number; year: number; value: number; sourceDate: string }
  >();

  for (const row of performance.rows) {
    const timestamp = Date.parse(`${row[dateHeader]} UTC`);
    const value = parseDataNumber(row[valueHeader]);
    if (!Number.isFinite(timestamp) || value === null) continue;
    const date = new Date(timestamp);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    monthly.set(year * 12 + month, {
      month,
      year,
      value,
      sourceDate: row[dateHeader],
    });
  }

  const points = [...monthly.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, point]) => ({ index, ...point }));
  const asOf = [...points].reverse().find((point) => [2, 5, 8, 11].includes(point.month));
  if (!asOf) return missing;
  const available = points.filter((point) => point.index <= asOf.index);

  const compound = (selected: typeof available) => {
    const factor = selected.reduce((product, point) => product * (1 + point.value / 100), 1);
    return { factor, cumulative: (factor - 1) * 100 };
  };
  const trailing = (months: number) => {
    const selected = available.slice(-months);
    if (
      selected.length !== months ||
      selected[0].index !== asOf.index - months + 1 ||
      selected[selected.length - 1].index !== asOf.index
    ) {
      return null;
    }
    return compound(selected);
  };

  const ytdPoints = available.filter((point) => point.year === asOf.year);
  const ytd =
    ytdPoints.length === asOf.month + 1 &&
    ytdPoints[0]?.month === 0 &&
    ytdPoints[ytdPoints.length - 1]?.month === asOf.month
      ? compound(ytdPoints).cumulative
      : null;

  const performanceMetrics = emptyMetrics();
  const totalReturnMetrics = emptyMetrics();
  performanceMetrics.YTD = ytd === null ? null : rounded(ytd);
  totalReturnMetrics.YTD = ytd === null ? null : rounded(ytd);

  for (const [period, years] of [
    ["1Y", 1],
    ["3Y", 3],
    ["5Y", 5],
    ["10Y", 10],
  ] as const) {
    const result = trailing(years * 12);
    if (!result) continue;
    totalReturnMetrics[period] = rounded(result.cumulative);
    performanceMetrics[period] =
      result.factor > 0 ? rounded((result.factor ** (1 / years) - 1) * 100) : null;
  }

  return {
    asOfDate: asOf.sourceDate,
    performance: performanceMetrics,
    totalReturn: totalReturnMetrics,
  };
}

/**
 * Return deterministic page paths for a row count. Page names are deliberately
 * based on position rather than a fetch timestamp, so a repeat run rewrites
 * existing pages (only when their content differs) instead of appending files.
 */
export function paginationPaths(folder: "holdings" | "history", rowCount: number, pageSize: number) {
  if (!Number.isInteger(rowCount) || rowCount < 0) {
    throw Error(`rowCount must be an integer >= 0; received ${rowCount}`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw Error(`pageSize must be an integer >= 1; received ${pageSize}`);
  }
  return Array.from({ length: Math.ceil(rowCount / pageSize) }, (_, index) => {
    const name = `${String(index + 1).padStart(3, "0")}.json`;
    return `./${folder}/${name}`;
  });
}

async function removeStalePages(
  ticker: string,
  folder: "holdings" | "history",
  keep: Set<string>,
) {
  const directory = new URL(`funds/${ticker}/${folder}/`, ROOT);
  let changed = false;
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Every JSON file in a generated page directory is owned by the
      // updater. Remove old page names, including pages from a prior format.
      if (entry.isFile() && entry.name.endsWith(".json") && !keep.has(entry.name)) {
        await rm(new URL(entry.name, directory), { force: true });
        changed = true;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return changed;
}

async function writePagedRows(
  ticker: string,
  folder: "holdings" | "history",
  headers: string[],
  rows: Array<Record<string, string>>,
  pageSize: number,
): Promise<{ manifest: PageManifest; changed: boolean }> {
  const pages = paginationPaths(folder, rows.length, pageSize);
  const keep = new Set(pages.map((path) => path.slice(path.lastIndexOf("/") + 1)));
  let changed = false;

  for (let index = 0; index < pages.length; index++) {
    const page = index + 1;
    const pageName = pages[index].slice(pages[index].lastIndexOf("/") + 1);
    changed =
      (await put(
        new URL(`funds/${ticker}/${folder}/${pageName}`, ROOT),
        JSON.stringify(
          {
            ticker,
            page,
            pageSize,
            totalRows: rows.length,
            headers,
            rows: rows.slice(index * pageSize, (index + 1) * pageSize),
          },
          null,
          2,
        ) + "\n",
      )) || changed;
  }

  changed = (await removeStalePages(ticker, folder, keep)) || changed;
  return {
    manifest: {
      totalRows: rows.length,
      pageSize,
      pageCount: pages.length,
      pages,
    },
    changed,
  };
}

async function removeLegacyFundFiles() {
  const directory = new URL("funds/", ROOT);
  let changed = false;
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[A-Z0-9]+\.json$/.test(entry.name)) continue;
      // Keep a legacy file when it is the only copy. This preserves the last
      // good dataset during a partial migration or catalog fallback.
      const ticker = entry.name.slice(0, -5);
      if (!(await old(new URL(`${ticker}/meta.json`, directory)))) continue;
      await rm(new URL(entry.name, directory), { force: true });
      changed = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return changed;
}

async function removeOrphanFundDirectories(keep: Set<string>, enabled: boolean) {
  if (!enabled) return false;
  const directory = new URL("funds/", ROOT);
  let changed = false;
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[A-Z0-9]+$/.test(entry.name) && !keep.has(entry.name)) {
        await rm(new URL(`${entry.name}/`, directory), { recursive: true, force: true });
        changed = true;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return changed;
}

async function updateFund(
  fund: Fund,
  config: UpdaterConfig,
  waitForRequest: () => Promise<void>,
): Promise<UpdateResult> {
  const download = `https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v1/get-fund-document?appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=us-ishares&locale=en_US&portfolioId=${fund.portfolioId}&component=fundDownload&userType=individual`;
  const body = await requestText(download, fund.ticker, config, waitForRequest);
  const worksheets = parseWorkbook(body);
  if (!Object.keys(worksheets).length) throw Error("no worksheets");

  const holdingsName = Object.keys(worksheets).find(
    (name) => name.trim().toLowerCase() === "holdings",
  );
  const historyName = Object.keys(worksheets).find((name) =>
    ["historical", "history"].includes(name.trim().toLowerCase()),
  );
  const holdings = holdingsName ? worksheets[holdingsName] : undefined;
  if (!holdings?.rows.length) {
    throw Error("Holdings worksheet is missing or empty");
  }
  const history = historyName ? worksheets[historyName] : undefined;

  const returns = deriveReturnMetrics(worksheets.Performance);
  const returnFailures = returnFilterReasons(returns, config);
  if (returnFailures.length) {
    return {
      ticker: fund.ticker,
      status: "filtered",
      reason: returnFailures.join(", "),
    };
  }

  const holdingsPages = await writePagedRows(
    fund.ticker,
    "holdings",
    holdings.headers,
    holdings.rows,
    config.holdingsPageSize,
  );
  const historyPages = await writePagedRows(
    fund.ticker,
    "history",
    history?.headers || [],
    history?.rows || [],
    config.historyPageSize,
  );
  let changed = holdingsPages.changed || historyPages.changed;

  if (holdingsName) delete worksheets[holdingsName];
  if (historyName) delete worksheets[historyName];
  const document = {
    ticker: fund.ticker,
    portfolioId: fund.portfolioId,
    name: fund.name,
    source: { fundPage: fund.fundPage, download },
    holdings: holdingsPages.manifest,
    history: historyPages.manifest,
    returns,
    worksheets,
  };
  changed =
    (await put(
      new URL(`funds/${fund.ticker}/meta.json`, ROOT),
      JSON.stringify(document, null, 2) + "\n",
    )) || changed;

  const legacy = new URL(`funds/${fund.ticker}.json`, ROOT);
  if (await old(legacy)) {
    await rm(legacy, { force: true });
    changed = true;
  }

  if (config.storeRawDownloads) {
    const rawUrl = new URL(`raw/${fund.ticker}.xls`, ROOT);
    if ((await old(rawUrl)) !== body) {
      await mkdir(RAW, { recursive: true });
      await writeFile(rawUrl, body);
      changed = true;
    }
  }

  const asOfDate =
    holdings.rows.find((row) => row["As Of Date"])?.["As Of Date"] || "";
  return {
    ticker: fund.ticker,
    status: changed ? "updated" : "unchanged",
    changed,
    indexFields: {
      dataFile: `./funds/${fund.ticker}/meta.json`,
      asOfDate,
      holdings: holdings.rows.length,
      history: history?.rows.length || 0,
      performance: { asOfDate: returns.asOfDate, ...returns.performance },
      totalReturn: { asOfDate: returns.asOfDate, ...returns.totalReturn },
    },
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
) {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

function rangeLabel(range?: Range) {
  if (!range) return "—";
  return `${range.min ?? ""}:${range.max ?? ""}`;
}

function configLines(config: UpdaterConfig) {
  const lines = [
    `MAX_FETCHES=${config.maxFetches || "all"}`,
    `REQUEST_SLEEP=${config.requestSleepSeconds}`,
    `MIN_AUM=${config.minAum ?? "—"}`,
    `MAX_AUM=${config.maxAum ?? "—"}`,
    `AUM_PRESET=${config.aumPreset}`,
    `CONCURRENCY=${config.concurrency}`,
    `HOLDINGS_PAGE_SIZE=${config.holdingsPageSize}`,
    `HISTORY_PAGE_SIZE=${config.historyPageSize}`,
    `STORE_RAW_DOWNLOADS=${config.storeRawDownloads}`,
    `MAX_RETRIES=${config.maxRetries}`,
    `TICKERS=${config.tickers.join(" ") || "all"}`,
    `MIN_DIVIDEND_YIELD=${config.minDividendYield ?? "—"}`,
    `MAX_DIVIDEND_YIELD=${config.maxDividendYield ?? "—"}`,
  ];
  for (const period of RETURN_PERIODS) {
    lines.push(`PERFORMANCE_${period}=${rangeLabel(config.performanceRanges[period])}`);
  }
  for (const period of RETURN_PERIODS) {
    lines.push(`TOTAL_RETURN_${period}=${rangeLabel(config.totalReturnRanges[period])}`);
  }
  return lines;
}

async function writeSummary(
  config: UpdaterConfig,
  discovered: number,
  candidates: number,
  results: UpdateResult[],
  manifestChanged: boolean,
) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const counts = (status: UpdateResult["status"]) =>
    results.filter((result) => result.status === status).length;
  const failures = results.filter((result) => result.status === "failed");
  const filtered = results.filter((result) => result.status === "filtered");
  const markdown = [
    "## iShares updater",
    "",
    "| Result | Count |",
    "|---|---:|",
    `| Catalog funds | ${discovered} |`,
    `| Fund update attempts | ${candidates} |`,
    `| Updated | ${counts("updated")} |`,
    `| Unchanged | ${counts("unchanged")} |`,
    `| Return-filtered | ${counts("filtered")} |`,
    `| Failed | ${counts("failed")} |`,
    `| Manifest changed | ${manifestChanged ? "yes" : "no"} |`,
    "",
    "<details><summary>Configuration</summary>",
    "",
    "```text",
    ...configLines(config),
    "```",
    "</details>",
    "",
  ];
  if (filtered.length) {
    markdown.push(
      "### Return-filtered funds",
      "",
      ...filtered.map((result) => `- **${result.ticker}**: ${result.reason}`),
      "",
    );
  }
  if (failures.length) {
    markdown.push(
      "### Failures",
      "",
      ...failures.map((result) => `- **${result.ticker}**: ${result.reason}`),
      "",
    );
  }
  await appendFile(summaryPath, `${markdown.join("\n")}\n`);
}

async function main() {
  const config = readConfig();
  console.log(`[config] ${configLines(config).join(" ")}`);
  const waitForRequest = createRequestGate(config.requestSleepSeconds);
  const previous = JSON.parse(
    (await old(new URL("index.json", ROOT))) || '{"funds":[]}',
  );
  const previousFunds: Fund[] = Array.isArray(previous.funds) ? previous.funds : [];
  const previousByTicker = new Map(previousFunds.map((fund) => [fund.ticker, fund]));

  let discovered: Fund[] = [];
  let usedCatalogFallback = false;
  try {
    discovered = parseCatalog(
      await requestText(
        "https://www.ishares.com/us/products/etf-investments",
        "catalog",
        config,
        waitForRequest,
      ),
    );
  } catch (error) {
    usedCatalogFallback = true;
    console.warn(`[catalog] live discovery failed; using previous manifest: ${String(error)}`);
    discovered = previousFunds;
  }
  if (!discovered.length) throw Error("catalog unavailable and no fallback");
  console.log(`[catalog] discovered=${discovered.length}`);

  const discoveredTickers = new Set(discovered.map((fund) => fund.ticker.toUpperCase()));
  for (const ticker of config.tickers) {
    if (!discoveredTickers.has(ticker)) console.warn(`[filter] requested ticker not found: ${ticker}`);
  }

  const tickerOrder = new Map(config.tickers.map((ticker, index) => [ticker, index]));
  const catalogEligible = discovered
    .filter((fund) => catalogFilterReasons(fund, config).length === 0)
    .sort((left, right) => {
      if (config.tickers.length) {
        return (tickerOrder.get(left.ticker) ?? Infinity) - (tickerOrder.get(right.ticker) ?? Infinity);
      }
      return left.ticker.localeCompare(right.ticker);
    });
  const candidates = config.maxFetches
    ? catalogEligible.slice(0, config.maxFetches)
    : catalogEligible;
  console.log(
    `[filter] catalogEligible=${catalogEligible.length} selectedForUpdate=${candidates.length}`,
  );

  const results = await mapWithConcurrency(
    candidates,
    config.concurrency,
    async (fund, index): Promise<UpdateResult> => {
      console.log(`[fund] ${index + 1}/${candidates.length} ticker=${fund.ticker} start`);
      try {
        const result = await updateFund(fund, config, waitForRequest);
        console.log(
          `[fund] ${index + 1}/${candidates.length} ticker=${fund.ticker} status=${result.status}${result.reason ? ` reason=${result.reason}` : ""}`,
        );
        return result;
      } catch (error) {
        const result: UpdateResult = {
          ticker: fund.ticker,
          status: "failed",
          reason: String(error),
        };
        console.warn(
          `[fund] ${index + 1}/${candidates.length} ticker=${fund.ticker} status=failed reason=${result.reason}`,
        );
        return result;
      }
    },
  );

  const resultByTicker = new Map(results.map((result) => [result.ticker, result]));
  const index = discovered.map((freshFund) => {
    const prior = previousByTicker.get(freshFund.ticker);
    const result = resultByTicker.get(freshFund.ticker);
    if (result?.indexFields) return { ...(prior || {}), ...freshFund, ...result.indexFields };
    // Filters and MAX_FETCHES limit updates, not the published catalog. Preserve
    // prior metadata/data for funds that were not successfully refreshed.
    if (prior) return prior;
    // A newly discovered fund remains discoverable even when this run did not
    // fetch it. It will receive dataFile/holdings on a later successful update.
    return freshFund;
  });
  index.sort((left, right) => left.ticker.localeCompare(right.ticker));

  // Remove obsolete flat fund files on every successful run. Removing whole
  // fund directories is more destructive, so only do that after a live catalog
  // that is not suspiciously smaller than the previous one.
  const catalogSafeForCleanup =
    !usedCatalogFallback &&
    (previousFunds.length === 0 || discovered.length >= Math.ceil(previousFunds.length * 0.7));
  if (!catalogSafeForCleanup && previousFunds.length) {
    console.warn("[cleanup] keeping orphan fund directories because catalog is incomplete");
  }
  const legacyFilesChanged = await removeLegacyFundFiles();
  const orphanDirectoriesChanged = await removeOrphanFundDirectories(
    new Set(index.map((fund) => fund.ticker)),
    catalogSafeForCleanup,
  );
  const cleanupChanged = legacyFilesChanged || orphanDirectoriesChanged;

  const stable = {
    source: { provider: "iShares", market: "us" },
    funds: index,
  };
  const priorStable = { ...previous };
  delete priorStable.generatedAt;
  const dataChanged = results.some((result) => result.changed) || cleanupChanged;
  const manifestChanged = JSON.stringify(priorStable) !== JSON.stringify(stable);
  const next = {
    generatedAt:
      dataChanged || manifestChanged || !previous.generatedAt
        ? new Date().toISOString()
        : previous.generatedAt,
    ...stable,
  };
  const indexChanged = await put(
    new URL("index.json", ROOT),
    JSON.stringify(next, null, 2) + "\n",
  );

  const count = (status: UpdateResult["status"]) =>
    results.filter((result) => result.status === status).length;
  console.log(
    `[summary] discovered=${discovered.length} attempted=${candidates.length} updated=${count("updated")} unchanged=${count("unchanged")} filtered=${count("filtered")} failed=${count("failed")} raw=${config.storeRawDownloads} cleanup=${cleanupChanged} manifestChanged=${indexChanged}`,
  );
  await writeSummary(config, discovered.length, candidates.length, results, indexChanged);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
