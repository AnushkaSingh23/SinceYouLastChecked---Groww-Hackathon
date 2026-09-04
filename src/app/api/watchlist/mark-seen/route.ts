import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { marketFeedStore } from "@/lib/marketFeedStore";

// Marks one symbol (or the whole watchlist, if no symbol given) as seen at
// its current live price — this is what flattens tiers back to QUIET and is
// the write side of "return later and see what changed."
export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "Not identified" }, { status: 401 });

  // Every other route that reads marketFeedStore calls this first; without
  // it, a mark-seen that happens to be the very first request against a
  // freshly-started server finds an empty quote cache and silently no-ops
  // every item forever (the poller never gets started).
  marketFeedStore.ensureStarted();

  const body = await request.json().catch(() => ({}));
  // An empty string is still `typeof "string"` — without the length check,
  // {"symbol": ""} would fall through the `symbol ? {symbol} : {}` filter
  // below and silently mark the user's ENTIRE watchlist as seen instead of
  // targeting (or rejecting) a single, invalid symbol.
  const symbol = typeof body?.symbol === "string" && body.symbol.length > 0 ? body.symbol : null;

  const items = await prisma.watchlistItem.findMany({
    where: { userId, ...(symbol ? { symbol } : {}) },
  });

  const now = new Date();
  const results = await Promise.all(
    items.map(async (item) => {
      const quote = marketFeedStore.getQuote(item.symbol);
      if (!quote) return false;

      await prisma.lastSeenSnapshot.upsert({
        where: { watchlistItemId: item.id },
        update: { price: quote.price, timestamp: now },
        create: { watchlistItemId: item.id, price: quote.price, timestamp: now },
      });
      return true;
    })
  );

  // Only count items that actually got a snapshot written — items with no
  // cached quote yet (cold start, or a symbol whose fetch failed this
  // cycle) are skipped above, and the response shouldn't claim otherwise.
  const updated = results.filter(Boolean).length;
  return NextResponse.json({ ok: true, updated });
}
