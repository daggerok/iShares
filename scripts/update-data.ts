#!/usr/bin/env bun
/// <reference types="node" />
/// <reference types="bun" />
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${`${String(index).padStart(width)}/${total}`.padEnd(8)} ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}

import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

let ROOT = new URL("../api/ishares/", import.meta.url);
let RAW = new URL("../api/ishares/raw/", import.meta.url);
let UPDATE_STATE = new URL("update-state.json", ROOT);
/** Tests point the updater at a temporary feed directory instead of api/ishares. */
export function setRootForTests(root: URL): void {
  ROOT = root;
  RAW = new URL("raw/", root);
  UPDATE_STATE = new URL("update-state.json", root);
}
/** A run stops taking new funds after this long and still writes the index (the workflow limit is 30 minutes). */
let softDeadlineMs = 25 * 60 * 1000;
export function setSoftDeadlineForTests(milliseconds: number): void {
  softDeadlineMs = milliseconds;
}
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
  terRange: Range | null;
  dividendYieldRange: Range | null;
  secYieldRange: Range | null;
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
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

type UpdateResult = {
  ticker: string;
  status: "updated" | "unchanged" | "filtered" | "failed";
  changed?: boolean;
  reason?: string;
  indexRow?: IndexRow;
};

const esc = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// Aligned console logging: every tag pads to the same width, tickers pad to
// the longest discovered ticker, and batch counters pad to the width of the
// total, so `ticker=`, progress, and status columns line up, e.g.
//   [ fund    ] ticker=IAT   167/480 status=unchanged
//   [ fetch   ] ticker=IAUM  attempt=2/3
const LOG_TAG_WIDTH = 8; // "[ progress ]" is the longest tag in use
let logTickerWidth = 4;

function logTag(
  tag: string,
  message: string,
  logger: (line: string) => void = console.log,
): void {
  logger(`[ ${tag.padEnd(LOG_TAG_WIDTH)} ] ${message}`);
}

function logTicker(ticker: string): string {
  return ticker.padEnd(logTickerWidth);
}

function logProgress(index: number, total: number): string {
  return `${String(index).padStart(String(total).length)}/${total}`;
}

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
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(parsed) || parsed < minimum) {
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
    maxRetries: parseInteger(envValue(env, "MAX_RETRIES"), "MAX_RETRIES", 2, 1),
    tickers: [
      ...new Set(
        envValue(env, "TICKERS")
          .toUpperCase()
          .split(/[\s,;]+/)
          .map((ticker) => ticker.trim())
          .filter(Boolean),
      ),
    ],
    terRange: parseRange(envValue(env, "TER"), "TER"),
    dividendYieldRange: parseRange(
      envValue(env, "DIVIDEND_YIELD"),
      "DIVIDEND_YIELD",
    ),
    secYieldRange: parseRange(envValue(env, "SEC_YIELD"), "SEC_YIELD"),
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

  if (config.terRange) {
    const ter = parseDataNumber(fund.netExpenseRatio) ?? parseDataNumber(fund.grossExpenseRatio);
    if (ter === null) reasons.push("expense ratio unavailable");
    else if (!inRange(ter, config.terRange)) reasons.push("expense ratio range");
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
 * Return all post-download return-filter failures. A bounded range excludes a
 * fund whose value for that period is unavailable (a young fund has nothing to
 * compare), like the catalog filters do for AUM, TER and yield.
 */
export function returnFilterReasons(metrics: ReturnMetrics, config: UpdaterConfig) {
  const reasons: string[] = [];
  for (const period of RETURN_PERIODS) {
    const performanceRange = config.performanceRanges[period];
    const performance = metrics.performance[period];
    if (performanceRange) {
      if (performance === null) reasons.push(`PERFORMANCE_${period} unavailable`);
      else if (!inRange(performance, performanceRange)) reasons.push(`PERFORMANCE_${period}=${performance}`);
    }
    const totalReturnRange = config.totalReturnRanges[period];
    const totalReturn = metrics.totalReturn[period];
    if (totalReturnRange) {
      if (totalReturn === null) reasons.push(`TOTAL_RETURN_${period} unavailable`);
      else if (!inRange(totalReturn, totalReturnRange)) reasons.push(`TOTAL_RETURN_${period}=${totalReturn}`);
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

// One pacing lane per concurrent worker. A single shared tail-chain
// serialized every request through one FIFO regardless of concurrency;
// CONCURRENCY workers now each get their own paced lane, so concurrency
// actually multiplies throughput as documented instead of only overlapping
// wait time.
export function createRequestGate(seconds: number, laneCount = 1): () => Promise<void> {
  const interval = seconds * 1_000;
  const count = Math.max(1, laneCount);
  const nextStart: number[] = new Array(count).fill(0);
  return () => {
    // The slot is reserved synchronously, before anything is awaited, so
    // callers that arrive in the same tick spread over the lanes.
    let lane = 0;
    for (let i = 1; i < count; i++) if (nextStart[i] < nextStart[lane]) lane = i;
    const start = Math.max(Date.now(), nextStart[lane]);
    nextStart[lane] = start + interval;
    const wait = start - Date.now();
    return wait > 0 ? sleep(wait).then(() => undefined) : Promise.resolve();
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
      // First attempts stay silent: one status line per fund is enough.
      // Only retries are worth a line, next to the matching [retry] warning.
      if (attempt > 1 && outputVerbose()) {
        logTag("fetch", `ticker=${logTicker(label)} attempt=${attempt}/${attempts}`);
      }
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
      if (outputVerbose()) logTag(
        "retry",
        `ticker=${logTicker(label)} in=${Math.round(delay / 1_000)}s reason=${String(error)}`,
        console.warn,
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

/**
 * Every feed file is compact JSON (no indentation) plus a trailing newline: the feed is close to the
 * 1 GB GitHub Pages site limit and the indentation alone was 28% of it.
 */
export function feedJson(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

/** Rows of a holdings or history page as arrays in header order (an object per row repeated every header text: 68% of the feed). */
export function pageRows(headers: ReadonlyArray<string>, rows: ReadonlyArray<Record<string, string>>): string[][] {
  return rows.map((row) => headers.map((header) => row[header] ?? ""));
}

let temporaryCounter = 0;
async function put(url: URL, contents: string) {
  if ((await old(url)) === contents) return false;
  await mkdir(new URL("./", url), { recursive: true });
  // tmp file + rename: an interrupted run never leaves a half-written JSON file.
  const temporary = new URL(`${url.href}.tmp-${process.pid}-${temporaryCounter++}`);
  await writeFile(temporary, contents);
  await rename(temporary, url);
  return true;
}

function updateScope(config: UpdaterConfig): UpdateScope {
  return {
    tickers: [...config.tickers],
    aumRange: config.aumRange ?? null,
    terRange: config.terRange ?? null,
    dividendYieldRange: config.dividendYieldRange ?? null,
    secYieldRange: config.secYieldRange ?? null,
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
  logTag("progress", `ignoring invalid ${UPDATE_STATE.pathname}`, console.warn);
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

export type SecYield = { value: string; asOf: string };

/**
 * Extracts the 30-Day SEC Yield from a `component=fundHeader` product-data
 * response (see https://www.ishares.com product pages). Returns null when the
 * fund does not publish the datapoint.
 */
export function parseSecYield(json: unknown): SecYield | null {
  const point = (
    json as {
      componentsByNameMap?: {
        fundHeader?: {
          containersByNameMap?: {
            yieldsAndRates?: {
              dataPointsByNameMap?: {
                thirtyDaySecYield?: {
                  formattedValue?: unknown;
                  formattedAsOfDate?: unknown;
                };
              };
            };
          };
        };
      };
    }
  )?.componentsByNameMap?.fundHeader?.containersByNameMap?.yieldsAndRates
    ?.dataPointsByNameMap?.thirtyDaySecYield;
  const raw =
    typeof point?.formattedValue === "string" ? point.formattedValue.trim() : "";
  if (!raw || raw === "—") return null;
  return {
    value: raw.replace(/%$/, ""),
    asOf:
      typeof point?.formattedAsOfDate === "string"
        ? point.formattedAsOfDate.trim()
        : "",
  };
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
    // Bond exports may omit Ticker; do not mistake the introductory fund metadata
    // for the holdings header and silently discard all security identifiers.
    if (headerIndex < 0) headerIndex = rows.findIndex((row) =>
      row.some((value) => /^(name|security name|cusip|isin|identifier|security[- ]id|sedol|figi)$/i.test(value))
      && row.some((value) => /^(asset class|market value|weight \(%\))$/i.test(value)),
    );
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

/** A calendar date as UTC midnight in milliseconds (NaN when unreadable): plain calendar text, never the local time zone. */
function calendarMs(value: unknown): number {
  const iso = calendarIso(value);
  return iso ? Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) : NaN;
}

/** Infer cadence conservatively from distinct payment events, never from payout amounts.
 * Prefer Ex-Date for a consistent series; use Payable Date only if Ex-Date lacks
 * three observations. Require two intervals and 80% agreement in the most recent
 * 13 events. Broad day windows allow month lengths/holidays, not mixed cadences.
 */
export function deriveDistributionFrequency(distributions?: Sheet): string {
  const unknown = "00 - None";
  if (!distributions) return unknown;
  let dates: number[] = [];
  for (const label of ["ex-date", "payable date"]) {
    const header = distributions.headers.find((h) => h.trim().toLowerCase() === label);
    if (!header) continue;
    dates = [...new Set(distributions.rows.map((row) => {
      const value = String(row[header] || "").trim();
      return calendarMs(value);
    }).filter(Number.isFinite))].sort((a, b) => b - a).slice(0, 13);
    if (dates.length >= 3) break;
  }
  if (dates.length < 3) return unknown;
  const gaps = dates.slice(1).map((date, i) => (dates[i] - date) / 86_400_000);
  const ordered = [...gaps].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  const cadences: Array<[number, number, string]> = [
    [20, 40, "01 - Monthly"],
    [70, 110, "04 - Quarterly"],
    [150, 215, "06 - Semi-annually"],
    [330, 400, "12 - Annually"],
  ];
  const cadence = cadences.find(([min, max]) => median >= min && median <= max
    && gaps.filter((gap) => gap >= min && gap <= max).length / gaps.length >= 0.8);
  return cadence?.[2] || "99 - Irregular";
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
    const timestamp = calendarMs(row[dateHeader]);
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

  // Since inception needs a contiguous monthly series: a missing month would
  // drop its return from the product while still counting toward the years.
  const spanMonths = asOf.index - available[0].index + 1;
  const contiguous = available.length === spanMonths;
  const sinceInception = compound(available);
  const siCum = contiguous ? rounded(sinceInception.cumulative) : null;
  // Annualizing a history shorter than one year extrapolates a few months into
  // a yearly rate: siAnn is published from 12 elapsed months on, null before.
  const siAnn =
    contiguous && spanMonths >= 12 && sinceInception.factor > 0
      ? rounded((sinceInception.factor ** (12 / spanMonths) - 1) * 100)
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
 * The shared "younger than one year" rule (calendar anniversary of the inception, inclusive): no 1, 3, 5 or 10-year return
 * and no annualized since-inception return before the fund is that old; an unknown date keeps the figures.
 */
export function withoutYoungMetrics(returns: ReturnMetrics, inception: unknown): ReturnMetrics {
  const horizons = { "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10 };
  return {
    ...withoutYoungReturns(returns, inception, returns.asOfDate, { siAnn: 1 }),
    performance: withoutYoungReturns(returns.performance, inception, returns.asOfDate, horizons),
    totalReturn: withoutYoungReturns(returns.totalReturn, inception, returns.asOfDate, horizons),
  };
}

/**
 * Holdings tickers (PS-1 rule): a bare ticker only for a security listed on a U.S. exchange; a local code of a foreign
 * listing (`2330` is TSMC in Taiwan and another company in Saudi Arabia) and the codes of futures, options, swaps, FX and
 * cash lines become `-`, so the Watchlist never merges two companies by ticker and Copy Tickers copies only U.S. symbols.
 * A sheet without a Ticker or an Exchange column is returned unchanged.
 */
export function withUsListingTickers(sheet: Sheet): Sheet {
  const tickerAt = sheet.headers.find((h) => h.trim().toLowerCase() === "ticker");
  const exchangeAt = sheet.headers.find((h) => h.trim().toLowerCase() === "exchange");
  const classAt = sheet.headers.find((h) => h.trim().toLowerCase() === "asset class");
  if (!tickerAt || !exchangeAt) return sheet;
  const usExchange = /^(nyse|nyse arca|nyse mkt llc|nyse american|nasdaq|cboe bzx|cboe edgx|iex|non-nms quotation service \(nnqs\))$/i;
  const nonSecurity = /futures|derivative|swap|^fx$|cash|money market|collateral/i;
  return {
    ...sheet,
    rows: sheet.rows.map((row) => {
      const ticker = String(row[tickerAt] ?? "").trim();
      if (!ticker || /^-+$/.test(ticker)) return row;
      const listed = usExchange.test(String(row[exchangeAt] ?? "").trim()) && !nonSecurity.test(String((classAt && row[classAt]) ?? ""));
      return listed ? row : { ...row, [tickerAt]: "-" };
    }),
  };
}

// --- Standard feed shapes (the same rows and per-fund meta in every ETF repo) ---
export const SITE = "https://www.ishares.com";
export const CATALOG_URL = `${SITE}/us/products/etf-investments`;
export const RETURNS_BASIS =
  "official iShares NAV total returns (compounded from the published monthly NAV return series, latest quarter-end)";
const HOLDINGS_SOURCE = "iShares full holdings workbook (product-data fund download)";
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];
const HISTORY_SOURCE = "iShares daily NAV per share history (same workbook; official NAV, not market price)";
const PROVIDER_SOURCE =
  "ishares.com official product table, product-data fund header and fund download workbook (SpreadsheetML)";
export const FEED_SOURCE = {
  provider: "iShares",
  market: "us",
  site: SITE,
  catalog: CATALOG_URL,
  holdings: HOLDINGS_SOURCE,
  history: HISTORY_SOURCE,
};
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jun 30, 2026" -> "2026-06-30" as plain calendar text (shared calendar-dates block); null when the text is not a date. */
export function isoDate(text: unknown): string | null {
  return calendarIso(text);
}

/** "Jun 30, 2026" -> "Jun 30 2026" (the display form used by the sibling feeds). */
export function displayDate(text: unknown): string | null {
  const iso = isoDate(text);
  if (!iso) return null;
  const [year, month, day] = iso.split("-");
  return `${MONTH_NAMES[Number(month) - 1]} ${day} ${year}`;
}

export function formatAum(value: number | null): string {
  if (value === null) return "—";
  for (const [unit, scale] of [["T", 1e12], ["B", 1e9], ["M", 1e6]] as const) {
    if (Math.abs(value) >= scale) return `$${(value / scale).toFixed(2)} ${unit}`;
  }
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

const percentText = (value: number | null): string => (value === null ? "—" : `${value.toFixed(2)}%`);

/** The iShares product header calls multi-asset funds "Multi Asset"; the feeds say "Multi-asset". */
export function normalizeAssetClass(raw: unknown): string | null {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!text || text === "-" || text === "—") return null;
  return /^multi[- ]?asset$/i.test(text) ? "Multi-asset" : text;
}

/**
 * Fallback category from the holdings sheet when the product header does not
 * publish an asset class: market-value mix of Equity, Fixed Income and
 * Alternative positions. Cash, derivatives and money-market sweeps are ignored
 * unless the fund is almost entirely money market.
 */
export function deriveAssetClass(rows: Array<Record<string, string>>): string {
  const sums: Record<string, number> = {};
  for (const row of rows) {
    const assetClass = String(row["Asset Class"] ?? "").trim();
    const value = parseDataNumber(row["Market Value"]);
    if (assetClass && value !== null && value > 0) sums[assetClass] = (sums[assetClass] ?? 0) + value;
  }
  const mix: Array<[string, number]> = [
    ["Equity", sums["Equity"] ?? 0],
    ["Fixed Income", sums["Fixed Income"] ?? 0],
    ["Alternative", sums["Alternative"] ?? 0],
  ];
  const invested = mix.reduce((total, [, value]) => total + value, 0);
  const money = sums["Money Market"] ?? 0;
  if (money > 0 && money >= 0.8 * (invested + money)) return "Money Market";
  if (invested <= 0) return "ETF";
  mix.sort((left, right) => right[1] - left[1]);
  if (mix[0][1] / invested < 0.8 && mix[1][1] / invested >= 0.15) return "Multi-asset";
  return mix[0][0];
}

export function cusipFromIsin(isin: string | null): string | null {
  return /^US([0-9A-Z]{9})\d$/.exec(isin ?? "")?.[1] ?? null;
}

/** Everything the `component=fundHeader` product-data response gives the feed. */
export function parseFundHeader(json: unknown): { secYield: SecYield | null; assetClass: string | null; isin: string | null } {
  const points = (json as {
    componentsByNameMap?: {
      fundHeader?: {
        containersByNameMap?: {
          fundName?: { dataPointsByNameMap?: Record<string, { value?: unknown } | undefined> };
        };
      };
    };
  })?.componentsByNameMap?.fundHeader?.containersByNameMap?.fundName?.dataPointsByNameMap;
  const isin = typeof points?.productIsin?.value === "string" ? points.productIsin.value.trim().toUpperCase() : "";
  return {
    secYield: parseSecYield(json),
    assetClass: normalizeAssetClass(points?.assetClass?.value),
    isin: /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) ? isin : null,
  };
}

/** "04 - Quarterly" -> label "Quarterly" with its payments per year. */
export function frequencyInfo(code: string): { label: string; paymentsPerYear: number | null } {
  const label = code.replace(/^\d+\s*-\s*/, "").trim() || "None";
  const perYear: Record<string, number> = { Monthly: 12, Quarterly: 4, "Semi-annually": 2, Annually: 1 };
  return { label, paymentsPerYear: perYear[label] ?? null };
}

export type IndexRow = Record<string, any> & { ticker: string };

export const CATEGORY_HEADER = "iShares product header asset class";
export const CATEGORY_DERIVED = "derived from the holdings market-value mix";

export type FundFacts = {
  fund: Fund;
  category: string;
  categorySource: string;
  isin: string | null;
  navValue: number | null;
  navAsOf: string;
  holdingsAsOf: string;
  returns: ReturnMetrics;
  secYield: SecYield | null;
  frequencyCode: string;
  distributionSheet?: Sheet;
  holdings: PageManifest;
  history: PageManifest;
  download: string;
  fundHeader: string;
  performanceSheet?: Sheet;
};

function expenseFields(fund: Fund) {
  const gross = parseDataNumber(fund.grossExpenseRatio);
  const net = parseDataNumber(fund.netExpenseRatio);
  const value = net ?? gross;
  return { gross, net, value };
}

function returnsBlock(returns: ReturnMetrics) {
  const period = {
    asOfDate: displayDate(returns.asOfDate),
    ytd: returns.performance.YTD,
    yr1: returns.performance["1Y"],
    yr3: returns.performance["3Y"],
    yr5: returns.performance["5Y"],
    yr10: returns.performance["10Y"],
    sinceInception: returns.siAnn,
  };
  // The series is compounded to a quarter end, which is also a month end.
  return { derivedFrom: RETURNS_BASIS, monthEnd: { ...period }, quarterEnd: { ...period } };
}

export type DividendYieldBasis =
  | "official-trailing-12m"
  | "official-distribution-rate"
  | "official-other"
  | "computed-trailing-12m"
  | "indicated";

/**
 * Which definition stands behind dividendYield. iShares has one yield source: the 12-month trailing
 * yield published in the product table, so a present yield is always official-trailing-12m and a
 * missing yield has no basis.
 */
export function yieldBasisFor(dividendYield: number | null | undefined): DividendYieldBasis | null {
  return typeof dividendYield === "number" && Number.isFinite(dividendYield) ? "official-trailing-12m" : null;
}

/** A kept (not refreshed) index row gets the standard key, in place, derived from the yield it carries. */
export function withYieldBasis<T extends Record<string, any>>(row: T): T {
  if (!row.metrics) return row;
  const metrics: Record<string, any> = {};
  for (const [key, value] of Object.entries(row.metrics)) {
    if (key === "dividendYieldBasis") continue;
    metrics[key] = value;
    if (key === "dividendYieldText") metrics.dividendYieldBasis = yieldBasisFor(row.metrics.dividendYield);
  }
  if (!("dividendYieldBasis" in metrics)) metrics.dividendYieldBasis = yieldBasisFor(row.metrics.dividendYield);
  return { ...row, metrics };
}

/** Standard metrics: cumulative total returns (tr*), annualized (cagr*), null when unavailable. */
export function buildMetrics(returns: ReturnMetrics, dividendYield: number | null, secYield: number | null) {
  return {
    ytd: returns.performance.YTD,
    tr1y: returns.totalReturn["1Y"],
    tr3y: returns.totalReturn["3Y"],
    tr5y: returns.totalReturn["5Y"],
    tr10y: returns.totalReturn["10Y"],
    cagr3y: returns.performance["3Y"],
    cagr5y: returns.performance["5Y"],
    cagr10y: returns.performance["10Y"],
    siAnn: returns.siAnn,
    dividendYield,
    dividendYieldText: percentText(dividendYield),
    dividendYieldBasis: yieldBasisFor(dividendYield),
    secYield,
    secYieldText: percentText(secYield),
    returnsBasis: RETURNS_BASIS,
    performanceAsOf: isoDate(returns.asOfDate),
  };
}

const emptyReturns = (): ReturnMetrics => ({
  asOfDate: "",
  performance: emptyMetrics(),
  totalReturn: emptyMetrics(),
  siAnn: null,
  siCum: null,
});

function distributionSummary(frequencyCode: string, sheet?: Sheet) {
  const { label, paymentsPerYear } = frequencyInfo(frequencyCode);
  const headers = sheet?.headers ?? [];
  const rows = (sheet?.rows ?? []).map((row) => headers.map((header) => row[header] ?? ""));
  const exHeader = headers.find((header) => header.trim().toLowerCase() === "ex-date");
  const amountHeader = headers.find((header) => header.trim().toLowerCase() === "total distribution");
  let latest: Record<string, string> | undefined;
  let latestIso = "";
  for (const row of sheet?.rows ?? []) {
    const iso = exHeader ? isoDate(row[exHeader]) : null;
    if (iso && iso > latestIso) { latestIso = iso; latest = row; }
  }
  const [year, month, day] = latestIso.split("-");
  return {
    label,
    paymentsPerYear,
    headers,
    rows,
    exDate: latest ? `${month}/${day}/${year}` : null,
    dividend: latest && amountHeader ? latest[amountHeader] || null : null,
  };
}

/** Index row for a fund that is only known from the product table (no workbook downloaded yet). */
export function buildCatalogRow(fund: Fund): IndexRow {
  const facts: FundFacts = {
    fund,
    category: "ETF",
    categorySource: "not downloaded yet",
    isin: null,
    navValue: null,
    navAsOf: "",
    holdingsAsOf: "",
    returns: emptyReturns(),
    secYield: null,
    frequencyCode: "",
    holdings: { totalRows: 0, pageSize: 0, pageCount: 0, pages: [] },
    history: { totalRows: 0, pageSize: 0, pageCount: 0, pages: [] },
    download: "",
    fundHeader: "",
  };
  const row = buildStandardFund(facts).row;
  row.dataFile = null;
  row.distributions = { frequency: null, exDate: null, dividend: null };
  return row;
}

/** One fund as the standard index row plus the standard per-fund meta.json document. */
export function buildStandardFund(facts: FundFacts): { row: IndexRow; meta: Record<string, any> } {
  const { fund, returns } = facts;
  const expense = expenseFields(fund);
  const aumValue = parseDataNumber(fund.netAssets);
  const dividendYield = parseDataNumber(fund.trailingYield);
  const secYield = parseDataNumber(facts.secYield?.value);
  const cusip = cusipFromIsin(facts.isin);
  const nav = facts.navValue === null ? "—" : `$${facts.navValue.toFixed(2)}`;
  const navAsOf = displayDate(facts.navAsOf);
  const holdingsAsOf = displayDate(facts.holdingsAsOf);
  const inceptionDate = displayDate(fund.inceptionDate) ?? (fund.inceptionDate && fund.inceptionDate !== "—" ? fund.inceptionDate : null);
  const terText = percentText(expense.value);
  const grossText = percentText(expense.gross);
  const dist = distributionSummary(facts.frequencyCode, facts.distributionSheet);
  const metrics = buildMetrics(returns, dividendYield, secYield);
  const block = returnsBlock(returns);
  const dataFile = `./funds/${fund.ticker}/meta.json`;

  const row: IndexRow = {
    ticker: fund.ticker,
    name: fund.name,
    category: facts.category,
    fundPage: fund.fundPage,
    dataFile,
    cusip,
    isin: facts.isin,
    ter: terText,
    terValue: expense.value,
    terGross: grossText,
    terGrossValue: expense.gross,
    nav,
    navValue: facts.navValue,
    aum: formatAum(aumValue),
    aumValue,
    asOfDate: navAsOf ?? holdingsAsOf,
    inceptionDate,
    exchange: null,
    closePrice: "—",
    closePriceValue: null,
    premiumDiscount: "—",
    premiumDiscountValue: null,
    distributions: { frequency: dist.label, exDate: dist.exDate, dividend: dist.dividend },
    returns: block,
    metrics,
    holdings: facts.holdings.totalRows,
    history: facts.history.totalRows,
  };

  const yieldAsOf = fund.yieldAsOf && fund.yieldAsOf !== "—" ? `, as of ${fund.yieldAsOf}` : "";
  const meta = {
    ticker: fund.ticker,
    name: fund.name,
    category: facts.category,
    categoryPath: facts.category,
    providerIds: { ticker: fund.ticker, portfolioId: fund.portfolioId, name: fund.name, fundPage: fund.fundPage },
    source: {
      fundPage: fund.fundPage,
      catalog: CATALOG_URL,
      holdingsDownload: facts.download,
      fundHeader: facts.fundHeader,
      categorySource: facts.categorySource,
      holdingsSource: HOLDINGS_SOURCE,
      historySource: HISTORY_SOURCE,
      provider: PROVIDER_SOURCE,
    },
    identifiers: { cusip, isin: facts.isin, indexTicker: null },
    inception: { fundInceptionDate: isoDate(fund.inceptionDate), shareClassInceptionDate: null, exchange: null },
    expenseRatio: { display: terText, value: expense.value, gross: expense.gross, net: expense.net },
    nav: { display: nav, value: facts.navValue, asOfDate: navAsOf },
    marketPrice: { display: "—", value: null, asOfDate: null },
    premiumDiscount: { display: "—", value: null },
    aum: { display: row.aum, value: aumValue, asOfDate: null, source: "ishares.com product table Net Assets (USD)" },
    yields: {
      dividendYield,
      dividendYieldText: metrics.dividendYieldText,
      dividendYieldBasis: metrics.dividendYieldBasis,
      dividendYieldKind: `12-month trailing yield published in the iShares product table${yieldAsOf}`,
      secYield,
      secYieldText: metrics.secYieldText,
      secYieldKind: facts.secYield
        ? `official 30-day SEC yield${facts.secYield.asOf ? `, as of ${facts.secYield.asOf}` : ""}`
        : "not published for this fund",
    },
    returns: block,
    officialReturns: {
      asOfDate: isoDate(returns.asOfDate),
      performance: returns.performance,
      totalReturn: returns.totalReturn,
      siAnn: returns.siAnn,
      siCum: returns.siCum,
    },
    distributions: {
      frequency: dist.label,
      frequencyCode: facts.frequencyCode,
      paymentsPerYear: dist.paymentsPerYear,
      headers: dist.headers,
      rows: dist.rows,
    },
    holdings: {
      ...facts.holdings,
      asOfDate: isoDate(facts.holdingsAsOf),
      asOf: holdingsAsOf,
      source: HOLDINGS_SOURCE,
      status: facts.holdings.totalRows ? "available" : "empty",
    },
    history: {
      ...facts.history,
      asOf: navAsOf,
      source: HISTORY_SOURCE,
    },
    worksheets: facts.performanceSheet ? { Performance: facts.performanceSheet } : {},
  };
  return { row, meta };
}

export function feedCounts(rows: IndexRow[]) {
  const sum = (key: "holdings" | "history") => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  return { funds: rows.length, holdings: sum("holdings"), history: sum("history") };
}

/** A previously published row rebuilt as the catalog entry the filters and the fetch loop expect. */
export function catalogFundFromRow(row: IndexRow): Fund {
  if (!row.metrics && row.portfolioId) return row as Fund; // pre-standard row: already catalog shaped
  const number = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? String(value) : "—");
  return {
    ticker: row.ticker,
    portfolioId: /\/products\/(\d+)\//.exec(String(row.fundPage))?.[1] ?? "",
    name: row.name,
    fundPage: row.fundPage,
    trailingYield: number(row.metrics?.dividendYield),
    yieldAsOf: "—",
    ytdReturn: "—",
    returnAsOf: "—",
    inceptionDate: row.inceptionDate || "—",
    grossExpenseRatio: number(row.terGrossValue),
    netExpenseRatio: number(row.terValue),
    netAssets: number(row.aumValue),
    type: "iShares ETF",
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

/** The published holdings pages of a fund (array rows in header order), empty when nothing is published. */
async function readPublishedHoldings(ticker: string, prior: Record<string, any>): Promise<{ headers: string[]; rows: unknown[][] }> {
  const out: { headers: string[]; rows: unknown[][] } = { headers: [], rows: [] };
  const pages: unknown[] = Array.isArray(prior?.holdings?.pages) ? prior.holdings.pages : [];
  for (let i = 0; i < pages.length; i++) {
    const name = String(pages[i]).slice(String(pages[i]).lastIndexOf("/") + 1);
    const page = JSON.parse((await old(new URL(`funds/${ticker}/holdings/${name}`, ROOT))) || "{}");
    if (!out.headers.length && Array.isArray(page.headers)) out.headers = page.headers.map(String);
    if (Array.isArray(page.rows)) for (const row of page.rows) if (Array.isArray(row)) out.rows.push(row);
  }
  return out;
}

async function writePagedRows(
  ticker: string,
  folder: "holdings" | "history",
  headers: string[],
  rows: Array<Record<string, string>>,
  pageSize: number,
): Promise<{ manifest: PageManifest; changed: boolean; keep: Set<string> }> {
  const pages = paginationPaths(folder, rows.length, pageSize);
  const keep = new Set(pages.map((path) => path.slice(path.lastIndexOf("/") + 1)));
  let changed = false;

  for (let index = 0; index < pages.length; index++) {
    const page = index + 1;
    const pageName = pages[index].slice(pages[index].lastIndexOf("/") + 1);
    changed =
      (await put(
        new URL(`funds/${ticker}/${folder}/${pageName}`, ROOT),
        feedJson({
          ticker,
          page,
          pageSize,
          totalRows: rows.length,
          headers,
          rows: pageRows(headers, rows.slice(index * pageSize, (index + 1) * pageSize)),
        }),
      )) || changed;
  }

  return {
    keep,
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
  const fundHeader = `https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v2/get-product-data?appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=us-ishares&locale=en_US&portfolioId=${fund.portfolioId}&userType=individual&component=fundHeader`;
  const body = await requestText(download, fund.ticker, config, waitForRequest);
  const worksheets = parseWorkbook(body);
  if (!Object.keys(worksheets).length) throw Error("no worksheets");

  let secYield: SecYield | null = null;
  let headerAssetClass: string | null = null;
  let isin: string | null = null;
  let headerFailed = false;
  try {
    const header = parseFundHeader(
      JSON.parse(await requestText(fundHeader, fund.ticker, config, waitForRequest)),
    );
    ({ secYield, assetClass: headerAssetClass, isin } = header);
  } catch (error) {
    headerFailed = true;
    if (outputVerbose()) logTag(
      "yield",
      `ticker=${logTicker(fund.ticker)} fund header unavailable: ${String(error)}`,
      console.warn,
    );
  }

  const holdingsName = Object.keys(worksheets).find(
    (name) => name.trim().toLowerCase() === "holdings",
  );
  const historyName = Object.keys(worksheets).find((name) =>
    ["historical", "history"].includes(name.trim().toLowerCase()),
  );
  const holdingsSheet = holdingsName ? worksheets[holdingsName] : undefined;
  const history = historyName ? worksheets[historyName] : undefined;
  // The previous meta tells a fund that never had holdings from a broken download.
  const prior = JSON.parse((await old(new URL(`funds/${fund.ticker}/meta.json`, ROOT))) || "{}");
  if (!holdingsSheet?.rows.length) {
    // Physical metal trusts (IAU, IAUM, SLV) publish no securities list: an
    // empty holdings sheet is valid for them, as long as the workbook carries a
    // NAV history and the fund never published holdings before. Anything else
    // is a broken download and keeps the previous complete fund state.
    const published = Number(prior?.holdings?.totalRows) || 0;
    if (published > 0) {
      throw Error(`Holdings worksheet is empty but ${published} rows are published; keeping the previous state`);
    }
    if (!history?.rows.length) throw Error("Holdings and history worksheets are both missing or empty");
  }
  const holdings: Sheet = holdingsSheet ? withUsListingTickers(holdingsSheet) : { headers: [], rows: [] };

  const distributionsName = Object.keys(worksheets).find(
    (name) => name.trim().toLowerCase() === "distributions",
  );
  const distributions = { frequencyCode: deriveDistributionFrequency(
    distributionsName ? worksheets[distributionsName] : undefined,
  ) };
  const returns = withoutYoungMetrics(deriveReturnMetrics(worksheets.Performance), fund.inceptionDate);
  const returnFailures = returnFilterReasons(returns, config);
  if (config.secYieldRange) {
    const value = parseDataNumber(secYield?.value);
    if (value === null) returnFailures.push("SEC yield unavailable");
    else if (!inRange(value, config.secYieldRange)) returnFailures.push(`SEC_YIELD=${value}`);
  }
  if (returnFailures.length) {
    return {
      ticker: fund.ticker,
      status: "filtered",
      reason: returnFailures.join(", "),
    };
  }

  // Fresh holdings that look broken (no weight column, non-numeric weights, a bad weight sum, half the rows gone)
  // never replace the published ones: the fund fails and keeps its previous complete state.
  const published = await readPublishedHoldings(fund.ticker, prior);
  const holdingsProblem = holdingsGuard(
    holdings.headers,
    holdings.rows,
    Number(prior?.holdings?.totalRows) || 0,
    HOLDINGS_GUARD_RELAX[fund.ticker] ?? HOLDINGS_GUARD_RELAX["*"] ?? [],
    published.rows.length ? holdingsWeightCount(published.headers, published.rows) : null,
  );
  if (holdingsProblem) {
    throw Error(`holdings guard: ${holdingsProblem}; ${prior?.ticker ? "keeping the previous state" : "no data published for this fund yet"}`);
  }
  const worksheetProblem = worksheetsProblem(prior, {
    historyRows: history?.rows.length ?? 0,
    returnsAsOf: returns.asOfDate,
    distributionRows: distributionsName ? worksheets[distributionsName].rows.length : 0,
  });
  if (worksheetProblem) throw Error(`${worksheetProblem}; keeping the previous state`);

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

  const asOfDate =
    holdings.rows.find((row) => row["As Of Date"])?.["As Of Date"] || "";
  const latestNavRow = history?.rows?.[0] || {};
  // A failed header request must not erase what an earlier run learned from it.
  if (headerFailed && !secYield && typeof prior?.yields?.secYield === "number") {
    secYield = { value: String(prior.yields.secYield), asOf: "" };
  }
  let category = headerAssetClass;
  if (!category && prior?.source?.categorySource === CATEGORY_HEADER && prior.category) category = prior.category;
  const categorySource = category ? CATEGORY_HEADER : CATEGORY_DERIVED;
  const { row, meta } = buildStandardFund({
    fund,
    category: category ?? deriveAssetClass(holdings.rows),
    categorySource,
    isin: isin ?? prior?.identifiers?.isin ?? null,
    navValue: parseDataNumber(latestNavRow["NAV per Share"]),
    navAsOf: latestNavRow["As Of"] || "",
    holdingsAsOf: asOfDate,
    returns,
    secYield,
    frequencyCode: distributions.frequencyCode,
    distributionSheet: distributionsName ? worksheets[distributionsName] : undefined,
    holdings: holdingsPages.manifest,
    history: historyPages.manifest,
    download,
    fundHeader,
    performanceSheet: worksheets.Performance,
  });
  changed =
    (await put(
      new URL(`funds/${fund.ticker}/meta.json`, ROOT),
      feedJson(meta),
    )) || changed;

  // Stale pages go only after the new meta.json (which lists the live pages) is in place.
  const prunedHoldings = await removeStalePages(fund.ticker, "holdings", holdingsPages.keep);
  const prunedHistory = await removeStalePages(fund.ticker, "history", historyPages.keep);
  changed = prunedHoldings || prunedHistory || changed;

  const legacy = new URL(`funds/${fund.ticker}.json`, ROOT);
  if (await old(legacy)) {
    await rm(legacy, { force: true });
    changed = true;
  }

  if (config.storeRawDownloads) {
    const rawUrl = new URL(`raw/${fund.ticker}.xls`, ROOT);
    if (await put(rawUrl, body)) changed = true;
  }

  return {
    ticker: fund.ticker,
    status: changed ? "updated" : "unchanged",
    changed,
    indexRow: row,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
  shouldStop: () => boolean = () => false,
) {
  const output = new Array<R | undefined>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      if (shouldStop()) return;
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

const HELP_FLAGS = new Set(["-h", "--help", "help"]);

function wantsHelp(args: string[]): boolean {
  return args.some((arg) => HELP_FLAGS.has(arg.toLowerCase()));
}

function printHelp(): void {
  console.log(`Update iShares ETF static data (api/ishares/**).

Usage:
  bun scripts/update-data.ts [-h|--help]

Defaults live in scripts/update-data.config.json; environment variables
(ISHARES_-prefixed aliases work too) override the file. All filters combine
with AND logic; filters limit which funds get updated, while the published
catalog keeps every fund and its previously stored data. A configured filter
also skips funds that do not publish the metric.

  MAX_FETCHES=0           Maximum fund update attempts this run; continue after
                          the saved cursor in api/ishares/update-state.json
                          (alias: ISHARES_LIMIT; 0 or empty = all)
  REQUEST_SLEEP=0         Minimum seconds between outgoing request starts
  AUM=":"                 Net-assets range min:max; bounds are USD amounts
                          (300M, 2B) or nano/micro/small/mid/large presets
  CONCURRENCY=4           Parallel fund update workers
  HOLDINGS_PAGE_SIZE=250  Rows per generated holdings JSON page
  HISTORY_PAGE_SIZE=1000  Rows per generated historical NAV JSON page
  STORE_RAW_DOWNLOADS=    Keep source XLS files (true/yes/on/1)
  MAX_RETRIES=2           Retries after the initial request (integer >= 1)
  TICKERS=                Only update these tickers (spaces or commas)
  TER=":"                 Net expense ratio range in % (gross when net is missing)
  DIVIDEND_YIELD=":"      12m trailing dividend yield range in %
  SEC_YIELD=":"           30-day SEC yield range in % (checked after download)
  PERFORMANCE_YTD=":"     YTD average-annual NAV performance range in %
  PERFORMANCE_1Y=":"      1Y average-annual NAV performance range in %
  PERFORMANCE_3Y=":"      3Y average-annual NAV performance (CAGR) range in %
  PERFORMANCE_5Y=":"      5Y average-annual NAV performance (CAGR) range in %
  PERFORMANCE_10Y=":"     10Y average-annual NAV performance (CAGR) range in %
  TOTAL_RETURN_YTD=":"    YTD cumulative NAV total-return range in %
  TOTAL_RETURN_1Y=":"     1Y cumulative NAV total-return (TR 1Y) range in %
  TOTAL_RETURN_3Y=":"     3Y cumulative NAV total-return (TR 3Y) range in %
  TOTAL_RETURN_5Y=":"     5Y cumulative NAV total-return (TR 5Y) range in %
  TOTAL_RETURN_10Y=":"    10Y cumulative NAV total-return (TR 10Y) range in %
  VERBOSE=false           Print per-fund retry and fallback notices
  USE_SYSTEM_CA=auto      TLS trust store: auto (restart once with --use-system-ca on an
                          untrusted-certificate error), true (always), false (never)

Ranges use strict inclusive min:max syntax ("15:", ":20", "5:20", "-5%:7.5",
":"); the colon is required.

Examples:
  TOTAL_RETURN_1Y="15:" ./scripts/update-data.ts
      Update only funds whose 1-year Total Return (TR 1Y) is at least 15%;
      funds with less than 15% are filtered out and keep their existing
      stored data.
  AUM="mid:" TICKERS="IVV AGG" ./scripts/update-data.ts
      Update only IVV and AGG when they have >= $2B net assets.
  MAX_FETCHES=20 ./scripts/update-data.ts
      Refresh the next batch of 20 funds, resuming after the saved cursor.`);
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
    `TER=${rangeLabel(config.terRange)}`,
    `DIVIDEND_YIELD=${rangeLabel(config.dividendYieldRange)}`,
    `SEC_YIELD=${rangeLabel(config.secYieldRange)}`,
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

// File defaults and explicit overrides, same mechanism as the sibling updaters:
// allowlisted scalar controls only, so GitHub Actions can resolve them without
// interpolating user input into bash. Precedence: config file < advanced JSON <
// nonblank inputs < environment (`ISHARES_<KEY>` wins over `<KEY>`; the legacy
// aliases ISHARES_LIMIT and HISTORICAL_PAGE_SIZE still work).
export const CONTROL_NAMES = [
  "MAX_FETCHES", "REQUEST_SLEEP", "AUM", "CONCURRENCY", "HOLDINGS_PAGE_SIZE", "HISTORY_PAGE_SIZE",
  "STORE_RAW_DOWNLOADS", "MAX_RETRIES", "TICKERS", "TER", "DIVIDEND_YIELD", "SEC_YIELD",
  ...["PERFORMANCE", "TOTAL_RETURN"].flatMap((prefix) =>
    RETURN_PERIODS.map((period) => `${prefix}_${period}`)),
  "VERBOSE", "USE_SYSTEM_CA",
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL("./update-data.config.json", import.meta.url);
const LEGACY_ALIASES: Record<string, string[]> = {
  MAX_FETCHES: ["ISHARES_LIMIT"],
  HISTORY_PAGE_SIZE: ["HISTORICAL_PAGE_SIZE"],
};

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Configuration must be a JSON object");
    }
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === "" || raw === undefined || raw === null)) continue;
      if (!["string", "number", "boolean"].includes(typeof raw)) {
        throw new Error(`${key}: expected string, number or boolean`);
      }
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = [`ISHARES_${key}`, key, ...(LEGACY_ALIASES[key] ?? [])]
      .map((name) => env[name])
      .find((candidate) => candidate !== undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ["STORE_RAW_DOWNLOADS", "VERBOSE"]) {
    if (result[key] && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key])) {
      throw new Error(`${key}: expected boolean`);
    }
  }
  if (result.USE_SYSTEM_CA !== undefined) {
    const mode = result.USE_SYSTEM_CA.toLowerCase();
    if (!["auto", "true", "false"].includes(mode)) {
      throw new Error("USE_SYSTEM_CA: expected auto, true or false");
    }
    result.USE_SYSTEM_CA = mode;
  }
  readConfig(result); // validate integers, sleep and every min:max filter before any request or write
  return result;
}

export async function runtimeControls(
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, string>> {
  let file: unknown = {};
  try {
    file = JSON.parse(await readFile(CONFIG_FILE_URL, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolveControls(file, {}, {}, env);
}

export type RunSummary = { attempted: number; updated: number; unchanged: number; filtered: number; failed: number; newFunds: string[] };

export async function main(
  args: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<RunSummary | undefined> {
  if (wantsHelp(args)) {
    printHelp();
    return;
  }
  const startedAt = Date.now();
  const controls = await runtimeControls(env);
  if (controls.VERBOSE !== undefined && env === process.env) process.env.VERBOSE = controls.VERBOSE;
  installSystemCa(controls.USE_SYSTEM_CA ?? "auto");
  const config = readConfig(controls);
  outputPrintConfig("iShares", config);
  const waitForRequest = createRequestGate(config.requestSleepSeconds, config.concurrency);
  const previous = JSON.parse(
    (await old(new URL("index.json", ROOT))) || '{"funds":[]}',
  );
  const previousRows: IndexRow[] = Array.isArray(previous.funds) ? previous.funds : [];
  const previousFunds: Fund[] = previousRows.map(catalogFundFromRow);
  const previousByTicker = new Map(previousRows.map((row) => [row.ticker, row]));

  let discovered: Fund[] = [];
  let usedCatalogFallback = false;
  try {
    discovered = parseCatalog(
      await requestText(
        CATALOG_URL,
        "catalog",
        config,
        waitForRequest,
      ),
    );
  } catch (error) {
    usedCatalogFallback = true;
    logTag("catalog", `live discovery failed; using previous manifest: ${String(error)}`, console.warn);
    discovered = previousFunds;
  }
  if (!discovered.length) throw Error("catalog unavailable and no fallback");
  logTickerWidth = Math.max(4, ...discovered.map((fund) => fund.ticker.length));
  logTag("catalog", `${discovered.length} iShares ETFs (${usedCatalogFallback ? "previous api/ishares/index.json" : "iShares ETF product list"})`);

  const discoveredTickers = new Set(discovered.map((fund) => fund.ticker.toUpperCase()));
  // The live catalog (null when only the published feed is known): a catalog-only row it no longer lists is dropped, never retried.
  const live = usedCatalogFallback ? null : discovered.map((fund) => fund.ticker.toUpperCase());
  // Q27: a TICKERS entry outside the live catalog and the published funds (closed ones included) stops the run before any fund request
  assertKnownTickers(config.tickers.length ? config.tickers : null, knownTickers(live, previousRows), "the iShares catalog or published feed");

  const tickerOrder = new Map(config.tickers.map((ticker, index) => [ticker, index]));
  // Closed funds leave the queue before any request and before the MAX_FETCHES budget is spent.
  const catalogEligible = withoutClosedFunds(discovered
    .filter((fund) => catalogFilterReasons(fund, config).length === 0)
    .sort((left, right) => {
      if (config.tickers.length) {
        return (tickerOrder.get(left.ticker) ?? Infinity) - (tickerOrder.get(right.ticker) ?? Infinity);
      }
      return left.ticker.localeCompare(right.ticker);
    }), (fund) => fund.ticker, CLOSED_FUNDS);
  const scope = updateScope(config);
  const progress = config.maxFetches ? await readUpdateProgress() : null;
  const lastProcessedTicker =
    progress && JSON.stringify(progress.scope) === JSON.stringify(scope)
      ? progress.lastProcessedTicker
      : "";
  const candidates = config.maxFetches
    ? selectUpdateBatch(catalogEligible, config.maxFetches, lastProcessedTicker)
    : catalogEligible;
  outputPrintFilter(catalogEligible.length, discovered.length, outputHasOutputFilters(config));
  const output = outputCreateReporter(ROOT, candidates.length);

  let deadlineHit = false;
  const outcomes = await mapWithConcurrency(
    candidates,
    config.concurrency,
    async (fund, index): Promise<UpdateResult> => {
      // No "start" line: a fund is visible exactly once, with its final status.
      const before = await output.before(fund.ticker);
      try {
        const result = await updateFund(fund, config, waitForRequest);
        await output.result(fund.ticker, before, result.status === "failed" ? "failed" : result.status === "filtered" ? "skipped" : undefined, result.reason, { portfolioId: fund.portfolioId, netAssets: fund.netAssets, trailingYield: fund.trailingYield });
        return result;
      } catch (error) {
        const result: UpdateResult = {
          ticker: fund.ticker,
          status: "failed",
          reason: String(error),
        };
        await output.result(fund.ticker, before, "failed", result.reason);
        return result;
      }
    },
    () => {
      if (Date.now() - startedAt < softDeadlineMs) return false;
      // reported once after the pool drains, so it never lands between fund lines
      deadlineHit = true;
      return true;
    },
  );
  const results = outcomes.filter((result): result is UpdateResult => result !== undefined);

  const resultByTicker = new Map(results.map((result) => [result.ticker, result]));
  const index: IndexRow[] = discovered.map((freshFund) => {
    const prior = previousByTicker.get(freshFund.ticker);
    const result = resultByTicker.get(freshFund.ticker);
    if (result?.indexRow) return result.indexRow;
    // Filters, MAX_FETCHES, a soft deadline and failures limit updates, not the
    // published catalog: a fund not refreshed keeps its complete previous row.
    if (prior?.metrics) return withYieldBasis(prior);
    // A newly discovered fund remains discoverable even when this run did not
    // fetch it (dataFile null, full metrics shape with null values).
    return buildCatalogRow(freshFund);
  });

  // A fund that vanished from the live catalog is removed (index row and
  // directory) only when a handful vanished: a partly parsed or truncated
  // catalog page must never delete funds, so then every previous row stays.
  // A closed fund is never pruned: its row and directory stay as published when the catalog drops it.
  const vanished = withoutStalePlaceholders(previousRows, live).filter((row) => !discoveredTickers.has(String(row.ticker).toUpperCase()));
  const missing = vanished.filter((row) => !closedFund(CLOSED_FUNDS, row.ticker));
  index.push(...vanished.filter((row) => closedFund(CLOSED_FUNDS, row.ticker)).map(withYieldBasis));
  const cleanupSafe =
    !usedCatalogFallback && missing.length <= Math.max(3, Math.floor(previousRows.length * 0.02));
  if (missing.length && !cleanupSafe) {
    logTag(
      "cleanup",
      `${missing.length} funds are missing from the catalog (${usedCatalogFallback ? "fallback" : "live"}): keeping their rows and directories`,
      console.warn,
    );
    index.push(...missing.map(withYieldBasis));
  }
  index.sort((left, right) => left.ticker.localeCompare(right.ticker));


  const legacyFilesChanged = await removeLegacyFundFiles();
  const orphanDirectoriesChanged = await removeOrphanFundDirectories(
    new Set(index.map((fund) => fund.ticker)),
    cleanupSafe,
  );
  const cleanupChanged = legacyFilesChanged || orphanDirectoriesChanged;

  // the 52-week range of every row from its published history pages (shared range-52w block)
  const funds = await withRange52w(ROOT, markClosedFunds(index, CLOSED_FUNDS));
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds = newFundsLines(newFundsReport(previousRows, funds));
  for (const line of newFunds) console.log(line);
  if (newFunds.length && env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### NEW FUNDS\n\n${newFunds.join("\n")}\n`);
  const stable = {
    source: FEED_SOURCE,
    counts: feedCounts(funds),
    funds,
  };
  const priorStable = { ...previous };
  delete priorStable.generatedAt;
  const dataChanged = results.some((result) => result.changed) || cleanupChanged;
  const manifestChanged = JSON.stringify(priorStable) !== JSON.stringify(stable);
  const next = {
    generatedAt:
      dataChanged || manifestChanged || !previous.generatedAt
        ? new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
        : previous.generatedAt,
    ...stable,
  };
  const indexChanged = await put(
    new URL("index.json", ROOT),
    feedJson(next),
  );

  let progressChanged = false;
  let processedThrough = "";
  const lastDone = outcomes.reduce((found, result, position) => (result ? position : found), -1);
  processedThrough = lastDone >= 0 ? candidates[lastDone].ticker : "";
  if (config.maxFetches && processedThrough) {
    progressChanged = await put(
      UPDATE_STATE,
      feedJson({
        version: 1,
        scope,
        lastProcessedTicker: processedThrough,
      } satisfies UpdateProgress),
    );
    logTag(
      "progress",
      `lastProcessed=${processedThrough} stateChanged=${progressChanged}`,
    );
  }

  const count = (status: UpdateResult["status"]) =>
    results.filter((result) => result.status === status).length;
  if (deadlineHit) logTag("deadline", `soft deadline of ${Math.round(softDeadlineMs / 60_000)} min reached: no new funds, writing the index`);
  console.log(output.summary(startedAt));
  console.log(outputCounts(stable.counts.funds, stable.counts.holdings, stable.counts.history));
  await writeSummary(
    config,
    discovered.length,
    candidates.length,
    results,
    indexChanged,
    progressChanged,
    processedThrough,
  );
  return {
    attempted: results.length,
    updated: count("updated"),
    unchanged: count("unchanged"),
    filtered: count("filtered"),
    failed: count("failed"),
    newFunds,
  };
}

if (import.meta.main) {
  main().then((summary) => {
    // Every attempted fund failed: the run produced nothing, so it must not look green.
    if (summary && summary.failed > 0 && summary.updated + summary.unchanged === 0) process.exitCode = 1;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

/**
 * The holdings sheet has its own guard; the other worksheets of the same download must not wipe published data either.
 * A Historical sheet without rows, a Performance sheet without one monthly return or a Distributions sheet without rows,
 * where the published meta.json has them, is a renamed or broken worksheet: the fund keeps its previous complete state
 * (history pages, official returns, distribution rows) and is reported failed. A fund that never published them passes.
 */
export function worksheetsProblem(
  prior: { history?: { totalRows?: unknown }; officialReturns?: { asOfDate?: unknown }; distributions?: { rows?: unknown } } | null | undefined,
  fresh: { historyRows: number; returnsAsOf: string; distributionRows: number },
): string | null {
  const publishedHistory = Number(prior?.history?.totalRows) || 0;
  if (publishedHistory > 0 && fresh.historyRows === 0) return `Historical worksheet is missing or empty but ${publishedHistory} rows are published`;
  const publishedReturns = prior?.officialReturns?.asOfDate;
  if (typeof publishedReturns === "string" && publishedReturns && !fresh.returnsAsOf) return `Performance worksheet has no monthly returns but returns as of ${publishedReturns} are published`;
  const publishedDistributions = Array.isArray(prior?.distributions?.rows) ? (prior?.distributions?.rows as unknown[]).length : 0;
  if (publishedDistributions > 0 && fresh.distributionRows === 0) return `Distributions worksheet is missing or empty but ${publishedDistributions} rows are published`;
  return null;
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>

// <range-52w> shared block of .claude/tools/etfs/etf-std/range-52w.block.ts, applied by apply-block.ts: never edit it in one repo
export type Range52w = {
  week52Low: number | null; week52High: number | null; range52w: number | null; range52wClose: number | null; range52wAsOf: string | null;
  range52wSince: string | null; range52wBasis: string | null;
};

/**
 * The price columns of a history sheet, tried in this order: the market close first, NAV only when no market price is
 * published. A function, not a const: the block sits at the end of update-data.ts, after the top-level `await main()`.
 */
export function range52wColumns(): string[] {
  return ['Close', 'Market Price', 'NAV', 'NAV per Share'];
}

/** The seven `metrics` keys of the 52-week range, all null: a catalog-only row and a fund without history carry this. */
export function range52wEmpty(): Range52w {
  return { week52Low: null, week52High: null, range52w: null, range52wClose: null, range52wAsOf: null, range52wSince: null, range52wBasis: null };
}

/**
 * The 52-week range from the closes of a fund's published history sheet (owner, 2026-10-29: closes, not intraday highs and
 * lows; no extra requests). `headers` are the sheet headers, `rows` objects keyed by header or arrays in header order.
 * - Price column: the first of range52wColumns() with at least two numeric values (`$1,234.50` reads as 1234.5); the date
 *   column is `Date`, else `As Of`, else the first header. Dates go through calendarIso, so every published format works
 * - Window: the last dated close and every close up to 52 weeks (364 days) before it. `week52Low` and `week52High` are the
 *   lowest and highest close of the window, `range52w` the position of the last close between them in percent
 *   (0 = at the low, 100 = at the high, 2 decimals). The last close is part of the window, so it never falls outside;
 *   `range52wClose` and `range52wAsOf` are that close and its date (it can differ from the row's closePrice source)
 * - A fund with less than 52 weeks of history gets the range since its first published close, and `range52wSince` names
 *   that date (owner: "alternative" - the range since launch with a note); a full window has `range52wSince: null`
 * - `range52wBasis` names the column used. Fewer than two closes give range52wEmpty(); a flat window (high = low) keeps
 *   low and high but `range52w: null`, never a made-up 0 or 50
 */
export function range52wMetrics(headers: string[], rows: unknown[]): Range52w {
  const list = Array.isArray(headers) ? headers.map((h) => String(h)) : [];
  const dateHeader = list.indexOf('Date') >= 0 ? 'Date' : list.indexOf('As Of') >= 0 ? 'As Of' : list[0];
  const cell = (row: unknown, header: string): unknown => {
    if (Array.isArray(row)) return row[list.indexOf(header)];
    return row && typeof row === 'object' ? (row as Record<string, unknown>)[header] : undefined;
  };
  const price = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    const text = String(value === null || value === undefined ? '' : value).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    const number = Number(text);
    return number > 0 ? number : null;
  };
  const all = Array.isArray(rows) ? rows : [], columns = range52wColumns();
  for (let c = 0; c < columns.length; c++) {
    const column = columns[c];
    if (list.indexOf(column) < 0 || !dateHeader) continue;
    const points: Array<{ date: string; close: number }> = [];
    for (let i = 0; i < all.length; i++) {
      const date = calendarIso(cell(all[i], dateHeader)), close = price(cell(all[i], column));
      if (date && close !== null) points.push({ date, close });
    }
    if (points.length < 2) continue;
    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const last = points[points.length - 1];
    const end = Date.UTC(Number(last.date.slice(0, 4)), Number(last.date.slice(5, 7)) - 1, Number(last.date.slice(8, 10)));
    const start = new Date(end - 364 * 86400000).toISOString().slice(0, 10);
    const window = points.filter((p) => p.date >= start);
    if (window.length < 2) continue;
    let low = window[0].close, high = window[0].close;
    for (let i = 1; i < window.length; i++) { low = Math.min(low, window[i].close); high = Math.max(high, window[i].close); }
    const round = (value: number, digits: number): number => Number(value.toFixed(digits));
    return {
      week52Low: round(low, 4), week52High: round(high, 4),
      range52w: high > low ? round(((last.close - low) / (high - low)) * 100, 2) : null, range52wClose: round(last.close, 4), range52wAsOf: last.date,
      range52wSince: points[0].date > start ? points[0].date : null,
      range52wBasis: column,
    };
  }
  return range52wEmpty();
}
/**
 * The index rows with the five 52-week keys in every `metrics`, computed from each fund's published history pages
 * (`funds/<T>/history/*.json` under `feedRoot`, the folder of index.json). Call it on the final rows right before
 * index.json is written: updated, unchanged and kept funds all get the range of the history they publish, a row without
 * `dataFile` or without history pages gets range52wEmpty(). A row without a `metrics` object is left as it is. The seven
 * keys go in front of `returnsBasis` and `performanceAsOf`, so those two stay the last keys of `metrics`.
 */
export async function withRange52w<T>(feedRoot: URL | string, funds: T[]): Promise<T[]> {
  const fs = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const root = feedRoot instanceof URL ? new URL(feedRoot.href.replace(/\/?$/, '/')) : pathToFileURL(String(feedRoot).replace(/\/?$/, '/'));
  const out: T[] = [];
  for (const fund of Array.isArray(funds) ? funds : []) {
    const row = fund as unknown as Record<string, unknown>;
    if (!row || typeof row !== 'object' || !row.metrics || typeof row.metrics !== 'object') { out.push(fund); continue; }
    let range = range52wEmpty();
    const dataFile = typeof row.dataFile === 'string' ? row.dataFile : '';
    if (dataFile) {
      const dir = new URL(`${dataFile.replace(/^\.\//, '').replace(/[^/]*$/, '')}history/`, root);
      const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => /\.json$/.test(name)).sort();
      let headers: string[] = [];
      const rows: unknown[] = [];
      for (const name of names) {
        const page = await fs.readFile(new URL(name, dir), 'utf8').then((text) => JSON.parse(text)).catch(() => null);
        if (!page || !Array.isArray(page.rows)) continue;
        if (!headers.length && Array.isArray(page.headers)) headers = page.headers;
        for (const item of page.rows) rows.push(item);
      }
      range = range52wMetrics(headers, rows);
    }
    // the range keys go in front of returnsBasis and performanceAsOf, which stay the last two keys (metrics contract)
    const metrics: Record<string, unknown> = {}, old = row.metrics as Record<string, unknown>, tail = ['returnsBasis', 'performanceAsOf'];
    for (const key of Object.keys(old)) if (tail.indexOf(key) < 0 && !(key in range)) metrics[key] = old[key];
    Object.assign(metrics, range);
    for (const key of tail) if (key in old) metrics[key] = old[key];
    out.push({ ...row, metrics } as unknown as T);
  }
  return out;
}
// </range-52w>
