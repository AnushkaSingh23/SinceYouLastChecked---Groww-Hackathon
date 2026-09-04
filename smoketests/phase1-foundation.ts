// Smoke test for Phase 1 — data foundation.
// Run with: npx tsx smoketests/phase1-foundation.ts
// Plain assertions, no test framework — fast to run, exits non-zero on failure.

import { fetchNSEUniverseQuotes } from "../src/lib/marketData";
import { NSE_40_UNIVERSE } from "../src/lib/nseUniverse";
import { getNSEMarketStatus } from "../src/lib/marketHours";
import { SymbolVolatilityTracker } from "../src/lib/volatility";

let failures = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`PASS: ${name}`);
  } else {
    console.error(`FAIL: ${name}`);
    failures++;
  }
}

async function main() {
  // Test case 1: universe resolution
  const quotes = await fetchNSEUniverseQuotes();
  check(
    `all ${NSE_40_UNIVERSE.length} universe symbols resolve (got ${quotes.length})`,
    quotes.length === NSE_40_UNIVERSE.length
  );

  // Test case 2: market status shape is sane (exact isOpen value depends on
  // when this runs, so just check it returns a well-formed result)
  const status = getNSEMarketStatus();
  check(
    "market status returns a valid reason",
    ["OPEN", "WEEKEND", "HOLIDAY", "OUTSIDE_HOURS"].includes(status.reason)
  );
  check("weekend correctly reported as closed", status.reason !== "WEEKEND" || status.isOpen === false);

  // Test case 3: volatility tracker cold start -> seed, then flips to live
  const tracker = new SymbolVolatilityTracker("RELIANCE.NS");
  const cold = tracker.getEffectiveVolatility();
  check("cold start uses seed (isLive: false)", cold.isLive === false);

  let price = 100;
  for (let i = 0; i < 15; i++) {
    price += (Math.random() - 0.5) * 2; // small random walk
    tracker.addTick(price);
  }
  const warm = tracker.getEffectiveVolatility();
  check("after 15 ticks, switches to live volatility", warm.isLive === true);

  console.log(failures === 0 ? "\nAll phase 1 smoke checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
