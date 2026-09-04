import { NextResponse } from "next/server";
import { marketFeedStore } from "@/lib/marketFeedStore";
import { NSE_40_UNIVERSE } from "@/lib/nseUniverse";

// Dev/demo-only: inject or clear a simulated market event on a symbol.
// Not user-scoped — this overlays the shared live feed everyone sees, which
// is the point: it's a presenter's control, not a per-user preference.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol : "";

  if (!NSE_40_UNIVERSE.some((s) => s.symbol === symbol)) {
    return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });
  }

  const priceOverridePct = typeof body?.priceOverridePct === "number" ? body.priceOverridePct : undefined;
  const volumeAnomalyRatio = typeof body?.volumeAnomalyRatio === "number" ? body.volumeAnomalyRatio : undefined;
  const headline = typeof body?.headline === "string" ? body.headline : undefined;

  if (priceOverridePct === undefined && volumeAnomalyRatio === undefined) {
    return NextResponse.json({ error: "Provide priceOverridePct and/or volumeAnomalyRatio" }, { status: 400 });
  }

  marketFeedStore.injectShock(symbol, { priceOverridePct, volumeAnomalyRatio, headline });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");

  if (symbol) marketFeedStore.clearShock(symbol);
  else marketFeedStore.clearAllShocks();

  return NextResponse.json({ ok: true });
}
