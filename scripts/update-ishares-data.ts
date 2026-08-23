#!/usr/bin/env bun
/// <reference types="node" />
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
const ROOT = new URL("../api/ishares/", import.meta.url),
  RAW = new URL("../api/ishares/raw/", import.meta.url);
const truthy = ["1", "true", "yes", "y", "on"];
const raw = truthy.includes(
  (process.env.ISHARES_STORE_RAW_DOWNLOADS || "").trim().toLowerCase(),
);
const limit = Number(process.env.ISHARES_LIMIT || 0);
const HOLDINGS_PAGE_SIZE = 250;
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
};
const esc = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
async function text(u: string) {
  const r = await fetch(u, {
    headers: { accept: "text/html,application/xml,*/*" },
  });
  if (!r.ok) throw Error(`${r.status} ${u}`);
  return await r.text();
}
async function old(u: URL) {
  try {
    return await readFile(u, "utf8");
  } catch {
    return "";
  }
}
async function put(u: URL, s: string) {
  if ((await old(u)) === s) return false;
  await mkdir(new URL("./", u), { recursive: true });
  await writeFile(u, s);
  return true;
}
function catalog(html: string) {
  const out: Fund[] = [];
  const rs = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  for (const r of rs) {
    const m = r.match(
      /href="(\/us\/products\/(\d+)\/[^"?]+)"[^>]*>([A-Z0-9]{1,10})<\/a>/,
    );
    if (!m || !/\b(ETF|Trust)\b/i.test(r)) continue;
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) =>
      esc(
        x[1]
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    );
    out.push({
      ticker: m[3],
      portfolioId: m[2],
      name: cells[1] || m[3],
      fundPage: `https://www.ishares.com${m[1]}`,
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
  return out;
}
function parse(xml: string) {
  const sheets: any = {};
  for (const m of xml.matchAll(
    /<ss:Worksheet[^>]*ss:Name="([^"]+)"[\s\S]*?>([\s\S]*?)<\/ss:Worksheet>/gi,
  )) {
    const rows = [...m[2].matchAll(/<ss:Row[\s\S]*?<\/ss:Row>/gi)]
      .map((x) =>
        [...x[0].matchAll(/<ss:Data[^>]*>([\s\S]*?)<\/ss:Data>/gi)].map((y) =>
          esc(y[1].replace(/<[^>]+>/g, "").trim()),
        ),
      )
      .filter((r) => r.some(Boolean));
    if (!rows.length) continue;
    let h = rows.findIndex((r) => r.some((v) => /^ticker$/i.test(v)));
    if (h < 0) h = rows.findIndex((r) => r.length > 1);
    if (h < 0) continue;
    const headers = rows[h].map((v, i) => v || `Column ${i + 1}`);
    sheets[m[1]] = {
      headers,
      rows: rows
        .slice(h + 1)
        .filter((r) => r.some(Boolean))
        .map((r) => Object.fromEntries(headers.map((x, i) => [x, r[i] || ""]))),
    };
  }
  return sheets;
}
async function one(f: Fund) {
  const url = `https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v1/get-fund-document?appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=us-ishares&locale=en_US&portfolioId=${f.portfolioId}&component=fundDownload&userType=individual`;
  const body = await text(url);
  const worksheets = parse(body);
  if (!Object.keys(worksheets).length) throw Error("no worksheets");

  const holdings = worksheets.Holdings || { headers: [], rows: [] };
  const pages = [];
  for (
    let start = 0;
    start < holdings.rows.length;
    start += HOLDINGS_PAGE_SIZE
  ) {
    const number = pages.length + 1;
    const file = `./holdings/${String(number).padStart(3, "0")}.json`;
    pages.push(file);
    await put(
      new URL(
        `funds/${f.ticker}/holdings/${String(number).padStart(3, "0")}.json`,
        ROOT,
      ),
      JSON.stringify(
        {
          ticker: f.ticker,
          page: number,
          pageSize: HOLDINGS_PAGE_SIZE,
          totalRows: holdings.rows.length,
          headers: holdings.headers,
          rows: holdings.rows.slice(start, start + HOLDINGS_PAGE_SIZE),
        },
        null,
        2,
      ) + "\n",
    );
  }
  delete worksheets.Holdings;
  const document = {
    ticker: f.ticker,
    portfolioId: f.portfolioId,
    name: f.name,
    source: { fundPage: f.fundPage, download: url },
    holdings: {
      totalRows: holdings.rows.length,
      pageSize: HOLDINGS_PAGE_SIZE,
      pageCount: pages.length,
      pages,
    },
    worksheets,
  };
  const changed = await put(
    new URL(`funds/${f.ticker}/meta.json`, ROOT),
    JSON.stringify(document, null, 2) + "\n",
  );
  await rm(new URL(`funds/${f.ticker}.json`, ROOT), { force: true });
  if (raw) {
    const u = new URL(`raw/${f.ticker}.xls`, ROOT);
    if ((await old(u)) !== body) {
      await mkdir(RAW, { recursive: true });
      await writeFile(u, body);
    }
  }
  return {
    changed,
    asOfDate: holdings.rows[0]?.["As Of Date"] || "",
    holdings: holdings.rows.length,
  };
}
async function main() {
  const previous = JSON.parse(
    (await old(new URL("index.json", ROOT))) || '{"funds":[]}',
  );
  let funds: Fund[] = [];
  try {
    funds = catalog(
      await text("https://www.ishares.com/us/products/etf-investments"),
    );
  } catch {
    funds = previous.funds || [];
  }
  if (!funds.length) throw Error("catalog unavailable and no fallback");
  if (limit) funds = funds.slice(0, limit);
  const index: any[] = [];
  let changed = false;
  for (let i = 0; i < funds.length; i += 4) {
    await Promise.all(
      funds.slice(i, i + 4).map(async (f) => {
        try {
          const r = await one(f);
          changed ||= r.changed;
          index.push({
            ...f,
            dataFile: `./funds/${f.ticker}/meta.json`,
            asOfDate: r.asOfDate,
            holdings: r.holdings,
          });
        } catch (e) {
          console.warn("failed", f.ticker, String(e));
        }
      }),
    );
  }
  index.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const stable = {
    source: { provider: "iShares", market: "us" },
    funds: index,
  };
  const prior = { ...previous };
  delete prior.generatedAt;
  const next = {
    generatedAt:
      JSON.stringify(prior) === JSON.stringify(stable)
        ? previous.generatedAt
        : new Date().toISOString(),
    ...stable,
  };
  await put(new URL("index.json", ROOT), JSON.stringify(next, null, 2) + "\n");
  console.log(`funds=${index.length} raw=${raw} changed=${changed}`);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
