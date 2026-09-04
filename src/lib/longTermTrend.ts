// Secondary feature: 1M/3M/6M/1Y historical performance per symbol, with a
// simple trend label. Explicitly secondary to "Since You Last Checked" —
// this data doesn't change intraday, so it's fetched once per symbol and
// cached for a day, completely separate from the live 20s polling loop
// that drives the primary feature. No dependency on the live quote cache.
//
// Known limitation, not fixed (out of scope — this would need corporate-
// action detection): a symbol that's a renamed continuation of a demerged
// company (TMPV.NS in our universe — see nseUniverse.ts) carries its
// predecessor's price history under the new ticker on Yahoo, so a 1-year
// return can reflect the value that split off into a separate stock, not a
// real single-company decline. The number is genuine Yahoo data, just a
// data-interpretation nuance for demerger-affected tickers specifically.

const TREND_TTL_MS = 24 * 60 * 60 * 1000;

export interface LongTermTrend {
  oneMonthPct: number | null;
  threeMonthPct: number | null;
  sixMonthPct: number | null;
  oneYearPct: number | null;
  label: "Upward" | "Downward" | "Mixed";
}

interface CacheEntry {
  trend: LongTermTrend;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<LongTermTrend | null>>();

const HISTORY_URL = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

/** Closest close to targetMs, or null if targetMs is before the earliest data we have (recently-listed stock) — a "closest available" fallback there would silently mislabel a 3-month-old stock's whole history as its "1-year return." */
function closeAt(timestamps: number[], closes: number[], targetMs: number): number | null {
  if (timestamps.length === 0 || targetMs < timestamps[0] * 1000) return null;
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const diff = Math.abs(timestamps[i] * 1000 - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  const c = closes[bestIdx];
  return typeof c === "number" ? c : null;
}

async function fetchTrend(symbol: string): Promise<LongTermTrend | null> {
  try {
    const res = await fetch(HISTORY_URL(symbol), {
      headers: { "User-Agent": BROWSER_UA },
      // Same reasoning as marketData.ts: this runs inside a request path, so
      // a stalled socket would hold a watchlist render open indefinitely.
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const timestamps: number[] | undefined = result?.timestamp;
    const closes: number[] | undefined = result?.indicators?.quote?.[0]?.close;
    if (!timestamps || !closes || timestamps.length === 0) return null;

    const latestClose = closes[closes.length - 1];
    if (typeof latestClose !== "number") return null;

    const now = Date.now();
    const monthsAgo = (n: number) => {
      const d = new Date(now);
      d.setMonth(d.getMonth() - n);
      return d.getTime();
    };
    const pctReturn = (thenClose: number | null) =>
      thenClose !== null && thenClose > 0 ? (latestClose - thenClose) / thenClose : null;

    const oneMonthPct = pctReturn(closeAt(timestamps, closes, monthsAgo(1)));
    const threeMonthPct = pctReturn(closeAt(timestamps, closes, monthsAgo(3)));
    const sixMonthPct = pctReturn(closeAt(timestamps, closes, monthsAgo(6)));
    const oneYearPct = pctReturn(closeAt(timestamps, closes, monthsAgo(12)));

    const returns = [oneMonthPct, threeMonthPct, sixMonthPct, oneYearPct].filter(
      (r): r is number => r !== null
    );
    const positives = returns.filter((r) => r > 0).length;
    const negatives = returns.filter((r) => r < 0).length;
    const label: LongTermTrend["label"] =
      positives > negatives ? "Upward" : negatives > positives ? "Downward" : "Mixed";

    return { oneMonthPct, threeMonthPct, sixMonthPct, oneYearPct, label };
  } catch {
    return null;
  }
}

/** Cached, deduped fetch — safe to call once per watchlist item on every request. */
export async function getLongTermTrend(symbol: string): Promise<LongTermTrend | null> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < TREND_TTL_MS) return cached.trend;

  let promise = inFlight.get(symbol);
  if (!promise) {
    promise = fetchTrend(symbol).finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, promise);
  }

  const trend = await promise;
  if (trend) {
    cache.set(symbol, { trend, fetchedAt: Date.now() });
    return trend;
  }
  // A failed refetch keeps serving the last good value rather than blanking it.
  return cached?.trend ?? null;
}
