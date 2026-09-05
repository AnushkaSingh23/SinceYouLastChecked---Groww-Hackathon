import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import { searchNSESymbols, type SymbolHit } from "@/lib/symbolSearch";
import { NSE_40_UNIVERSE } from "@/lib/nseUniverse";

// Live NSE symbol search. Replaces filtering a hardcoded 40-ticker array in
// the browser, which capped the watchlist at those 40 and shipped the whole
// table (sectors, volatility seeds) into the client bundle.
//
// Requires an identified user: this proxies an upstream search, and an open
// unauthenticated proxy is something other people will eventually find.

const MAX_RESULTS = 10;

/**
 * Curated names are matched locally and listed FIRST, because the upstream
 * search is unreliable on exactly the names people are most likely to type:
 * "infosys" returns HCL Infosystems but not INFY, and "tata" buries the large
 * caps. Local matching guarantees the well-known names always resolve, while
 * the live search supplies everything else on the exchange.
 */
function curatedMatches(q: string): SymbolHit[] {
  const needle = q.toLowerCase();
  return NSE_40_UNIVERSE.filter(
    (s) =>
      s.name.toLowerCase().includes(needle) ||
      s.symbol.toLowerCase().includes(needle) ||
      s.sector.toLowerCase().includes(needle)
  ).map((s) => ({ symbol: s.symbol, name: s.name, sector: s.sector }));
}

export async function GET(request: Request) {
  if (!(await getCurrentUserId())) {
    return NextResponse.json({ error: "Not identified" }, { status: 401 });
  }

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();

  // Empty query returns the curated set as suggestions, so the dropdown has
  // something useful in it before the user types anything.
  if (q.length < 2) {
    return NextResponse.json({
      results: NSE_40_UNIVERSE.slice(0, 12).map((s) => ({
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
      })),
      suggested: true,
    });
  }

  const [live, curated] = [await searchNSESymbols(q), curatedMatches(q)];

  // Curated first, then live, de-duplicated by symbol.
  const seen = new Set<string>();
  const results: SymbolHit[] = [];
  for (const hit of [...curated, ...live]) {
    if (seen.has(hit.symbol)) continue;
    seen.add(hit.symbol);
    results.push(hit);
    if (results.length >= MAX_RESULTS) break;
  }

  return NextResponse.json({ results, suggested: false });
}
