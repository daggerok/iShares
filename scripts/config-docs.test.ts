/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls, runtimeControls } from './update-data';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json'));
const workflow = read('.github/workflows/update-data.yml');

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'IVV' }, { CONCURRENCY: 3, TICKERS: 'AGG' }, { CONCURRENCY: '4', TICKERS: '' }, { ISHARES_CONCURRENCY: '5', CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('5'); expect(c.TICKERS).toBe('AGG');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }, { CONCURRENCY: '7' }).CONCURRENCY).toBe('7');
  expect(resolveControls({ TICKERS: 'IVV' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ STORE_RAW_DOWNLOADS: true }, {}, {}, { STORE_RAW_DOWNLOADS: 'false' }).STORE_RAW_DOWNLOADS).toBe('false');
  expect(readConfig(resolveControls({ MAX_RETRIES: 0 })).maxRetries).toBe(0);
});

test('legacy environment aliases keep working', () => {
  expect(readConfig(resolveControls(file(), {}, {}, { ISHARES_LIMIT: '3' })).maxFetches).toBe(3);
  expect(readConfig(resolveControls(file(), {}, {}, { HISTORICAL_PAGE_SIZE: '37' })).historyPageSize).toBe(37);
  expect(readConfig(resolveControls(file(), {}, {}, { ISHARES_STORE_RAW_DOWNLOADS: 'yes' })).storeRawDownloads).toBe(true);
});

test('resolver rejects unknown, invalid and environment-file injection values', () => {
  for (const value of [{ UNKNOWN: 1 }, { TICKERS: 'IVV\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { STORE_RAW_DOWNLOADS: 'maybe' }, { AUM: '1:2:3' }, { PERFORMANCE_1Y: '5' }, { TICKERS: ['IVV'] }, { OUTPUT_DIR: '/tmp/x' }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { TICKERS: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { ISHARES_TICKERS: 'x\0bad' })).toThrow();
  expect(() => resolveControls({}, [])).toThrow();
});

test('config file defaults: every control, provider values, scheduled path equals defaults', async () => {
  expect(Object.keys(file()).sort()).toEqual([...CONTROL_NAMES].sort());
  for (const value of Object.values(file())) expect(typeof value).toBe('string');
  const config = readConfig(resolveControls(file()));
  expect(config.tickers).toEqual([]); expect(config.maxFetches).toBe(0); expect(config.requestSleepSeconds).toBe(0);
  expect(config.concurrency).toBe(4); expect(config.holdingsPageSize).toBe(250); expect(config.historyPageSize).toBe(1000);
  expect(config.maxRetries).toBe(2); expect(config.storeRawDownloads).toBe(false);
  expect(config.aumRange).toBeUndefined(); expect(config.dividendYieldRange).toBeUndefined();
  expect(config.performanceRanges).toEqual({}); expect(config.totalReturnRanges).toEqual({});
  // scheduled run: empty advanced and inputs, no protected variables
  expect(resolveControls(file(), JSON.parse('{}'), {}, {})).toEqual(resolveControls(file()));
  // runtime path reads the same file
  expect(await runtimeControls({})).toEqual(resolveControls(file()));
  expect((await runtimeControls({ TICKERS: 'IVV' })).TICKERS).toBe('IVV');
});

test('controls, config file, --help and README are in sync', async () => {
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
