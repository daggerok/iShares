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
const UPDATE_STATE = new URL("update-state.json", ROOT);
const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const AUM_PRESET_BOUNDS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: undefined },
} as const;
type AumPreset = keyof typeof AUM_PRESET_BOUNDS;
export const RETURN_PERIODS = ["YTD", "1Y", "3Y", "5Y", "10Y"] as const;
type ReturnPeriod = (typeof RETURN_PERIODS)[number];

type Range = { min?: number; max?: number };
type AumRange = Range & {
  maxExclusive?: boolean;
  source: string;
};
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
  siAnn: number | null;
  siCum: number | null;
};

type PageManifest = {
  totalRows: number;
  pageSize: number;
  pageCount: number;
  pages: string[];
};

type UpdateScope = {
  tickers: string[];
  aumRange: AumRange | null;
  dividendYieldRange: Range | null;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

type UpdateProgress = {
  version: 1;
  scope: UpdateScope;
  lastProcessedTicker: string;
};

export type UpdaterConfig = {
  maxFetches: number;
  requestSleepSeconds: number;
  aumRange?: AumRange;
  concurrency: number;
  holdingsPageSize: number;
  historyPageSize: number;
  storeRawDownloads: boolean;
  maxRetries: number;
  tickers: string[];
  dividendYieldRange?: Range;
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
 * Parse an inclusive numeric range. Every non-empty value must contain exactly
 * one colon. Empty input and ":" both mean no restriction.
 */
export function parseRange(value: string, name = "range"): Range | undefined {
  const input = value.trim();
  if (!input) return undefined;
  const parts = input.split(":");
  if (parts.length !== 2) {
    throw Error(
      `${name} must contain exactly one colon using min:max syntax; received ${JSON.stringify(value)}`,
    );
  }
  const min = parts[0].trim() ? parseConfigNumber(parts[0], name) : undefined;
  const max = parts[1].trim() ? parseConfigNumber(parts[1], name) : undefined;
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) {
    throw Error(`${name} minimum cannot exceed its maximum`);
  }
  return { min, max };
}

function isAumPreset(value: string): value is AumPreset {
  return Object.hasOwn(AUM_PRESET_BOUNDS, value);
}

/**
 * Parse an AUM range. A bound can be a USD amount or an AUM preset. Presets on
 * the left contribute their lower boundary; presets on the right contribute
 * their exclusive upper boundary.
 */
export function parseAumRange(value: string, name = "AUM"): AumRange | undefined {
  const input = value.trim();
  if (!input) return undefined;
  const parts = input.split(":");
  if (parts.length !== 2) {
    throw Error(
      `${name} must contain exactly one colon using min:max syntax; received ${JSON.stringify(value)}`,
    );
  }
  const [rawMin, rawMax] = parts.map((part) => part.trim());
  if (!rawMin && !rawMax) return undefined;

  const parseBound = (bound: string, side: "min" | "max") => {
    if (!bound) return { value: undefined, preset: false };
    const preset = bound.toLowerCase();
    if (isAumPreset(preset)) {
      return {
        value: AUM_PRESET_BOUNDS[preset][side],
        preset: true,
      };
    }
    return { value: parseAum(bound, name), preset: false };
  };

  const minBound = parseBound(rawMin, "min");
  const maxBound = parseBound(rawMax, "max");
  const min = minBound.value;
  const max = maxBound.value;
  const maxExclusive = maxBound.preset && max !== undefined;
  if (
    min !== undefined &&
    max !== undefined &&
    (min > max || (maxExclusive && min >= max))
  ) {
    throw Error(`${name} minimum cannot reach or exceed its maximum`);
  }
  return { min, max, maxExclusive, source: input };
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
    aumRange: parseAumRange(envValue(env, "AUM"), "AUM"),
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
    dividendYieldRange: parseRange(
      envValue(env, "DIVIDEND_YIELD"),
      "DIVIDEND_YIELD",
    ),
    performanceRanges: parseRanges(env, "PERFORMANCE"),
    totalReturnRanges: parseRanges(env, "TOTAL_RETURN"),
  };

  if (config.requestSleepSeconds < 0) throw Error("REQUEST_SLEEP must be >= 0");
  return config;
}

function inRange(value: number, range: Range) {
  return !(
    (range.min !== undefined && value < range.min) ||
    (range.max !== undefined && value > range.max)
  );
}

/** Return all catalog-only reasons why a fund is not eligible. */
export function catalogFilterReasons(fund: Fund, config: UpdaterConfig) {
  const reasons: string[] = [];
  if (config.tickers.length && !config.tickers.includes(fund.ticker.toUpperCase())) {
    reasons.push("ticker");
  }

  if (config.aumRange) {
    const aum = parseDataNumber(fund.netAssets);
    if (aum === null) reasons.push("AUM unavailable");
    else {
      if (config.aumRange.min !== undefined && aum < config.aumRange.min) {
        reasons.push("minimum AUM");
      }
      if (
        config.aumRange.max !== undefined &&
        (config.aumRange.maxExclusive
          ? aum >= config.aumRange.max
          : aum > config.aumRange.max)
      ) {
        reasons.push("maximum AUM");
      }
    }
  }

  if (config.dividendYieldRange) {
    const dividendYield = parseDataNumber(fund.trailingYield);
    if (dividendYield === null) reasons.push("dividend yield unavailable");
    else if (!inRange(dividendYield, config.dividendYieldRange)) {
      reasons.push("dividend yield range");
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
      console.log(`[fetch] ticker=${label} attempt=${attempt}/${attempts}`);
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

function updateScope(config: UpdaterConfig): UpdateScope {
  return {
    tickers: [...config.tickers],
    aumRange: config.aumRange ?? null,
    dividendYieldRange: config.dividendYieldRange ?? null,
    performanceRanges: config.performanceRanges,
    totalReturnRanges: config.totalReturnRanges,
  };
}

async function readUpdateProgress() {
  const contents = await old(UPDATE_STATE);
  if (!contents) return null;
  try {
    const parsed = JSON.parse(contents) as Partial<UpdateProgress>;
    if (
      parsed.version === 1 &&
      typeof parsed.lastProcessedTicker === "string" &&
      parsed.scope &&
      typeof parsed.scope === "object"
    ) {
      return parsed as UpdateProgress;
    }
  } catch {
    // Treat a malformed local state file as an uninitialized cursor.
  }
  console.warn(`[progress] ignoring invalid ${UPDATE_STATE.pathname}`);
  return null;
}

/**
 * Select a bounded round-robin batch after the previous ticker. The input is
 * already ordered by the caller; this function never mutates it and never
 * duplicates a fund within one batch.
 */
export function selectUpdateBatch<T extends { ticker: string }>(
  values: T[],
  maxFetches: number,
  lastProcessedTicker = "",
) {
  if (!Number.isInteger(maxFetches) || maxFetches < 0) {
    throw Error(`maxFetches must be an integer >= 0; received ${maxFetches}`);
  }
  if (!maxFetches || maxFetches >= values.length) return values.slice();

  const previousIndex = values.findIndex(
    (value) => value.ticker.toUpperCase() === lastProcessedTicker.toUpperCase(),
  );
  const start = previousIndex < 0 ? 0 : (previousIndex + 1) % values.length;
  return Array.from(
    { length: Math.min(maxFetches, values.length) },
    (_, offset) => values[(start + offset) % values.length],
  );
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
    siAnn: null,
    siCum: null,
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

  const sinceInception = compound(available);
  const sinceInceptionYears = available.length / 12;
  const siCum = rounded(sinceInception.cumulative);
  const siAnn =
    sinceInceptionYears > 0 && sinceInception.factor > 0
      ? rounded((sinceInception.factor ** (1 / sinceInceptionYears) - 1) * 100)
      : null;

  return {
    asOfDate: asOf.sourceDate,
    performance: performanceMetrics,
    totalReturn: totalReturnMetrics,
    siAnn,
    siCum,
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
  const latestNavRow = history?.rows?.[0] || {};
  const navValue = parseDataNumber(latestNavRow["NAV per Share"]);
  return {
    ticker: fund.ticker,
    status: changed ? "updated" : "unchanged",
    changed,
    indexFields: {
      dataFile: `./funds/${fund.ticker}/meta.json`,
      asOfDate,
      holdings: holdings.rows.length,
      history: history?.rows.length || 0,
      nav: navValue === null ? "—" : `$${navValue.toFixed(2)}`,
      navValue,
      navAsOf: latestNavRow["As Of"] || "",
      performance: { asOfDate: returns.asOfDate, ...returns.performance, SI: returns.siAnn },
      totalReturn: { asOfDate: returns.asOfDate, ...returns.totalReturn, SI: returns.siCum },
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
  if (!range) return ":";
  return `${range.min ?? ""}:${range.max ?? ""}`;
}

function configLines(config: UpdaterConfig) {
  const lines = [
    `MAX_FETCHES=${config.maxFetches || "all"}`,
    `REQUEST_SLEEP=${config.requestSleepSeconds}`,
    `AUM=${config.aumRange?.source ?? ":"}`,
    `CONCURRENCY=${config.concurrency}`,
    `HOLDINGS_PAGE_SIZE=${config.holdingsPageSize}`,
    `HISTORY_PAGE_SIZE=${config.historyPageSize}`,
    `STORE_RAW_DOWNLOADS=${config.storeRawDownloads}`,
    `MAX_RETRIES=${config.maxRetries}`,
    `TICKERS=${config.tickers.join(" ") || "all"}`,
    `DIVIDEND_YIELD=${rangeLabel(config.dividendYieldRange)}`,
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
  progressChanged: boolean,
  processedThrough: string,
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
    `| Progress state changed | ${progressChanged ? "yes" : "no"} |`,
    `| Processed through | ${processedThrough || "—"} |`,
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
  const scope = updateScope(config);
  const progress = config.maxFetches ? await readUpdateProgress() : null;
  const lastProcessedTicker =
    progress && JSON.stringify(progress.scope) === JSON.stringify(scope)
      ? progress.lastProcessedTicker
      : "";
  const candidates = config.maxFetches
    ? selectUpdateBatch(catalogEligible, config.maxFetches, lastProcessedTicker)
    : catalogEligible;
  console.log(
    `[filter] catalogEligible=${catalogEligible.length} selectedForUpdate=${candidates.length}${config.maxFetches ? ` startingAfter=${lastProcessedTicker || "start"}` : ""}`,
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

  let progressChanged = false;
  let processedThrough = "";
  if (config.maxFetches && candidates.length) {
    processedThrough = candidates[candidates.length - 1].ticker;
    progressChanged = await put(
      UPDATE_STATE,
      JSON.stringify(
        {
          version: 1,
          scope,
          lastProcessedTicker: processedThrough,
        } satisfies UpdateProgress,
        null,
        2,
      ) + "\n",
    );
    console.log(
      `[progress] lastProcessed=${processedThrough} stateChanged=${progressChanged}`,
    );
  }

  const count = (status: UpdateResult["status"]) =>
    results.filter((result) => result.status === status).length;
  console.log(
    `[summary] discovered=${discovered.length} attempted=${candidates.length} updated=${count("updated")} unchanged=${count("unchanged")} filtered=${count("filtered")} failed=${count("failed")} raw=${config.storeRawDownloads} cleanup=${cleanupChanged} manifestChanged=${indexChanged} progressChanged=${progressChanged} processedThrough=${processedThrough || "—"}`,
  );
  await writeSummary(
    config,
    discovered.length,
    candidates.length,
    results,
    indexChanged,
    progressChanged,
    processedThrough,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
