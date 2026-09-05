import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import { marketFeedStore } from "@/lib/marketFeedStore";
import { isBenchmark } from "@/lib/benchmarks";

// Dev/demo-only: inject or clear a simulated market event on a symbol.
// Not user-scoped — this overlays the shared live feed everyone sees, which
// is the point: it's a presenter's control, not a per-user preference.
//
// That shared-state design is exactly why this needs a gate. Unguarded, a
// deployed build lets an anonymous caller push a fabricated price move and a
// fabricated news headline about a real, named, publicly traded company onto
// every viewer's screen, and wipe everyone's simulations with a DELETE. The
// SIMULATED badge is the only mitigation and it's client-side.
//
// Enabled automatically outside production. In a deployed demo, set
// ENABLE_DEMO_SHOCKS=true to turn it back on — an explicit opt-in, so the
// live demo still works without the endpoint being open by default.
function demoShocksEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_DEMO_SHOCKS === "true";
}

// A function, not a shared constant: a Response body can only be consumed
// once, so handing the same instance to two requests breaks the second.
const disabledResponse = () =>
  NextResponse.json(
    { error: "Simulated events are disabled. Set ENABLE_DEMO_SHOCKS=true to enable them." },
    { status: 404 }
  );

export async function POST(request: Request) {
  if (!demoShocksEnabled()) return disabledResponse();
  // Even when enabled, require an identified user — a demo control is for
  // someone using the app, not for an anonymous caller on the internet.
  if (!(await getCurrentUserId())) return NextResponse.json({ error: "Not identified" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol : "";

  // Any NSE ticker, not just the curated set — the watchlist is no longer
  // capped at 40 symbols, so the demo control must not be either. A shock only
  // means anything for a symbol the feed is already tracking, which is exactly
  // the set that has a quote cached.
  // Benchmarks are shockable too: simulating a market-wide sell-off is the
  // only way to demonstrate that a stock falling *with* the market gets
  // softened rather than shouted about.
  if (!isBenchmark(symbol) && !/^[A-Z0-9&._-]{1,20}\.NS$/.test(symbol)) {
    return NextResponse.json({ error: "Not a valid NSE symbol" }, { status: 400 });
  }
  if (!marketFeedStore.getQuote(symbol)) {
    return NextResponse.json(
      { error: "No live quote for that symbol yet — add it to a watchlist first." },
      { status: 400 }
    );
  }

  const priceOverridePct = typeof body?.priceOverridePct === "number" ? body.priceOverridePct : undefined;
  const volumeAnomalyRatio = typeof body?.volumeAnomalyRatio === "number" ? body.volumeAnomalyRatio : undefined;
  const headline = typeof body?.headline === "string" ? body.headline : undefined;

  if (priceOverridePct === undefined && volumeAnomalyRatio === undefined) {
    return NextResponse.json({ error: "Provide priceOverridePct and/or volumeAnomalyRatio" }, { status: 400 });
  }
  // A pct <= -1 (-100%) or beyond makes the resulting price zero or
  // negative — found during review: -1.5 produced a currentPrice of
  // -1156.20. Bound it to something that can never happen to a real stock
  // but still supports any demo scenario (a >300% single-event spike is
  // already absurd for a simulated news event).
  if (priceOverridePct !== undefined && (priceOverridePct <= -1 || priceOverridePct > 3)) {
    return NextResponse.json({ error: "priceOverridePct must be greater than -1 and at most 3" }, { status: 400 });
  }
  if (volumeAnomalyRatio !== undefined && volumeAnomalyRatio < 0) {
    return NextResponse.json({ error: "volumeAnomalyRatio must be non-negative" }, { status: 400 });
  }

  marketFeedStore.injectShock(symbol, { priceOverridePct, volumeAnomalyRatio, headline });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!demoShocksEnabled()) return disabledResponse();
  if (!(await getCurrentUserId())) return NextResponse.json({ error: "Not identified" }, { status: 401 });

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");

  if (symbol) marketFeedStore.clearShock(symbol);
  else marketFeedStore.clearAllShocks();

  return NextResponse.json({ ok: true });
}
