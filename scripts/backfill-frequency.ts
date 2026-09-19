#!/usr/bin/env bun
// Offline migration: uses only already-published distribution history. No downloads.
import { deriveDistributionFrequency } from "./update-data";
const root = new URL("../api/ishares/", import.meta.url);
const indexFile = Bun.file(new URL("index.json", root));
const index = await indexFile.json();
for (const fund of index.funds) {
  const file = Bun.file(new URL(`funds/${fund.ticker}/meta.json`, root));
  if (!(await file.exists())) continue;
  const meta = await file.json();
  const name = Object.keys(meta.worksheets || {}).find(
    (name) => name.trim().toLowerCase() === "distributions",
  );
  meta.distributions = {
    frequencyCode: deriveDistributionFrequency(
      name ? meta.worksheets[name] : undefined,
    ),
  };
  fund.distributions = meta.distributions;
  await Bun.write(file, JSON.stringify(meta, null, 2) + "\n");
}
await Bun.write(indexFile, JSON.stringify(index, null, 2) + "\n");
