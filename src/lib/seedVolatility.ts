// Derives a starting volatility for ANY NSE symbol from its own real price
// history, instead of a hand-written constant per ticker.
//
// This is what lets the watchlist cover the whole exchange. The 40-ticker
// universe existed because every symbol needed a `baseSigma` seed typed in by
// hand — the data source was never the limit. Measuring it removes the limit
// and is more accurate besides: checked against the hand-written table, the
// derived value matched closely for HDFCBANK (0.0134 vs 0.013) and was
// materially better for the volatile names, where the hardcoded figures had
// drifted to roughly double the realised value (ADANIENT 0.0196 vs 0.038).
//
// Still a *seed*: once ~10 live ticks have arrived this session, volatility.ts
// switches to its own live-observed estimate. This only has to be right enough
// to score the first few minutes sensibly.

const HISTORY_URL = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const REQUEST_TIMEOUT_MS = 8_000;
// Volatility drifts slowly; a day-old seed is fine and this keeps one request
// per symbol per day rather than one per process start.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_BARS = 20;

// Guard rails. A symbol with a corporate action in its window can produce an
// absurd stdev, and a near-zero sigma would make every ordinary move read as a
// huge z-score. These bracket anything a real listed equity plausibly does.
const MIN_SIGMA = 0.004; // 0.4% daily
const MAX_SIGMA = 0.12; //  12% daily

interface CacheEntry {
  sigma: number;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<number | null>>();

async function computeSigma(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(HISTORY_URL(symbol), {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;

    const data = await res.json();
    const raw: unknown[] = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    // Yahoo returns nulls for non-trading days; drop them rather than treating
    // a gap as a price of zero.
    const closes = raw.filter((c): c is number => typeof c === "number" && c > 0);
    if (closes.length < MIN_BARS) return null;

    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    // Sample variance (n-1), the standard choice for a volatility estimate.
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const sigma = Math.sqrt(variance);

    if (!Number.isFinite(sigma) || sigma <= 0) return null;
    return Math.min(Math.max(sigma, MIN_SIGMA), MAX_SIGMA);
  } catch {
    return null;
  }
}

/** Cached, deduplicated. Returns null when history is unavailable — callers fall back. */
export async function getSeedVolatility(symbol: string): Promise<number | null> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.sigma;

  let promise = inFlight.get(symbol);
  if (!promise) {
    promise = computeSigma(symbol).finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, promise);
  }
  const sigma = await promise;

  if (sigma !== null) {
    cache.set(symbol, { sigma, fetchedAt: Date.now() });
    return sigma;
  }
  // A failed refetch keeps serving the last good value rather than discarding it.
  return cached?.sigma ?? null;
}

/** Synchronous read of an already-derived seed, for the scoring hot path. */
export function getCachedSeedVolatility(symbol: string): number | null {
  return cache.get(symbol)?.sigma ?? null;
}

/** Kicks off derivation without waiting — used when a symbol is first watched. */
export function warmSeedVolatility(symbol: string): void {
  if (cache.has(symbol) || inFlight.has(symbol)) return;
  void getSeedVolatility(symbol);
}
