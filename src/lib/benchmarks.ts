// Benchmark indices, used to answer "is this stock actually unusual, or is the
// whole market moving?"
//
// A 3.1% drop means two completely different things:
//
//   ITC -3.1%, NIFTY 50 -0.2%   -> something happened to ITC
//   ITC -3.1%, NIFTY 50 -2.9%   -> the market fell; ITC came along
//
// Before this, the app said the same thing for both, which is the single
// biggest source of false urgency in an attention product: on a broad
// sell-off, every card turns red and none of it is news about any one stock.
//
// These are always polled regardless of what anyone watches, because they are
// scoring inputs rather than watchlist items.

import { NSE_40_UNIVERSE } from "./nseUniverse";

export interface Benchmark {
  symbol: string;
  name: string;
}

export const NIFTY_50: Benchmark = { symbol: "^NSEI", name: "NIFTY 50" };
export const NIFTY_BANK: Benchmark = { symbol: "^NSEBANK", name: "NIFTY Bank" };

export const BENCHMARKS: Benchmark[] = [NIFTY_50, NIFTY_BANK];
export const BENCHMARK_SYMBOLS = BENCHMARKS.map((b) => b.symbol);

export function isBenchmark(symbol: string): boolean {
  return BENCHMARK_SYMBOLS.includes(symbol);
}

// Sectors where NIFTY Bank is the more honest comparison than the broad index.
// Banks move together far more tightly than the market as a whole, so judging
// a bank against NIFTY 50 overstates how unusual an ordinary sector move is.
const BANKING_SECTORS = new Set([
  "Banking",
  "PSU Banking",
  "NBFC",
  "Financial Services",
  "PSU Financial",
  "Fintech",
]);

const SECTOR_BY_SYMBOL = new Map(NSE_40_UNIVERSE.map((s) => [s.symbol, s.sector]));

/**
 * Which index to judge a symbol against. Sector is only known for the curated
 * set; everything else falls back to the broad market, which is the safe
 * default — NIFTY 50 is a reasonable benchmark for any NSE equity.
 */
export function benchmarkFor(symbol: string): Benchmark {
  const sector = SECTOR_BY_SYMBOL.get(symbol);
  return sector && BANKING_SECTORS.has(sector) ? NIFTY_BANK : NIFTY_50;
}
