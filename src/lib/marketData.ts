// Live NSE quotes via Yahoo Finance's public v8 chart endpoint.
//
// The v7 batch quote endpoint (`/v7/finance/quote?symbols=a,b,c`) that's
// commonly recommended for this no longer works unauthenticated — verified
// directly against it on 2026-09-04, it now returns 401 Unauthorized and
// needs a session cookie + crumb token Yahoo doesn't hand out for free.
// The v8 chart endpoint (`/v8/finance/chart/<symbol>`) is still open with no
// auth, also verified directly, but it's single-symbol only — no batching.
// So the universe is fetched as N individual requests with a small
// concurrency cap and stagger, not one batched call.

import { NSE_40_UNIVERSE } from "./nseUniverse";

export interface NSEQuote {
  symbol: string;
  price: number;
  changePct: number;
  volume: number;
  /** null when Yahoo's response omits this — scoring.ts must not treat a missing bound as "crossed." */
  high52w: number | null;
  low52w: number | null;
  prevClose: number;
  /** Epoch ms of the exchange's own timestamp for this quote. */
  sourceTimestamp: number;
}

const CHART_URL = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

export async function fetchNSEQuote(symbol: string): Promise<NSEQuote | null> {
  try {
    const res = await fetch(CHART_URL(symbol), { headers: { "User-Agent": BROWSER_UA } });
    if (!res.ok) return null;

    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== "number") return null;

    return {
      symbol,
      price: meta.regularMarketPrice,
      changePct: meta.regularMarketChangePercent ?? 0,
      volume: meta.regularMarketVolume ?? 0,
      // If Yahoo omits these, defaulting to the current price would make
      // `price >= high52w` (or `<= low52w`) trivially true forever — a
      // permanent false "level break" for that symbol. null is explicit
      // about "we don't know" instead of encoding it as a numeric sentinel
      // (Infinity would also silently become `null` once this crosses a
      // JSON response anyway, so there's no safe numeric trick here).
      high52w: meta.fiftyTwoWeekHigh ?? null,
      low52w: meta.fiftyTwoWeekLow ?? null,
      prevClose: meta.chartPreviousClose ?? meta.regularMarketPrice,
      sourceTimestamp: (meta.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000,
    };
  } catch {
    return null;
  }
}

/**
 * Fetches the whole universe with a small concurrency cap so we don't fire
 * 40 simultaneous requests at an unofficial endpoint. Returns only the
 * symbols that resolved — callers should expect an occasional gap and keep
 * showing the last known value for anything missing this cycle.
 */
export async function fetchNSEUniverseQuotes(
  symbols: string[] = NSE_40_UNIVERSE.map((s) => s.symbol),
  concurrency = 8
): Promise<NSEQuote[]> {
  const results: NSEQuote[] = [];
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((s) => fetchNSEQuote(s)));
    for (const r of batchResults) if (r) results.push(r);
  }
  return results;
}
