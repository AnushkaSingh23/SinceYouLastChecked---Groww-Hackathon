// Live NSE symbol search, so the watchlist isn't capped at a hardcoded list.
//
// The app used to ship a fixed 40-ticker universe and filter it client-side,
// which meant a real NSE stock the user actually held — Tata Power, say —
// simply could not be added. The data source was never the limit: Yahoo serves
// every NSE symbol. The limit was the hand-written volatility seed each ticker
// needed, and seedVolatility.ts removes that by deriving sigma from real
// history instead. See nseUniverse.ts, which survives as a curated starter set
// and an offline fallback.

const SEARCH_URL = (q: string) =>
  `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=25&newsCount=0&enableFuzzyQuery=false`;

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const REQUEST_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

export interface SymbolHit {
  /** Yahoo ticker, always ends in `.NS`. */
  symbol: string;
  name: string;
  /** Yahoo's short sector/industry label when it gives one — purely cosmetic. */
  sector: string | null;
}

interface CacheEntry {
  hits: SymbolHit[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SymbolHit[]>>();

/** Yahoo labels the NSE as "NSI". Anything else (BSE, US listings) is not what this app scores. */
function isNSE(quote: { symbol?: unknown; exchange?: unknown; quoteType?: unknown }): boolean {
  return (
    typeof quote.symbol === "string" &&
    quote.symbol.endsWith(".NS") &&
    quote.exchange === "NSI" &&
    quote.quoteType === "EQUITY"
  );
}

async function fetchSearch(query: string): Promise<SymbolHit[]> {
  try {
    const res = await fetch(SEARCH_URL(query), {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return [];

    const data = await res.json();
    const quotes: unknown[] = Array.isArray(data?.quotes) ? data.quotes : [];

    const hits: SymbolHit[] = [];
    for (const raw of quotes) {
      const q = raw as Record<string, unknown>;
      if (!isNSE(q)) continue;
      hits.push({
        symbol: q.symbol as string,
        name: (q.shortname as string) ?? (q.longname as string) ?? (q.symbol as string),
        sector: typeof q.sector === "string" ? q.sector : typeof q.industry === "string" ? q.industry : null,
      });
    }
    return hits;
  } catch {
    // A search failure is not worth surfacing as an error — the UI shows
    // "no matches" and the user can retry by typing.
    return [];
  }
}

/**
 * Cached, deduplicated NSE symbol search. Returns [] for anything under two
 * characters — a single letter matches most of the exchange and is never what
 * someone means.
 */
export async function searchNSESymbols(query: string): Promise<SymbolHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const cached = cache.get(q);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.hits;

  let promise = inFlight.get(q);
  if (!promise) {
    promise = fetchSearch(q).finally(() => inFlight.delete(q));
    inFlight.set(q, promise);
  }
  const hits = await promise;

  if (hits.length > 0) {
    // Crude bound so a stream of distinct queries can't grow this without
    // limit; the oldest insertion goes first, which is good enough here.
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(q, { hits, fetchedAt: Date.now() });
  }
  return hits;
}
