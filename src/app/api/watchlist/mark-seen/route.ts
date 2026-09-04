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

  const body = await request.json().catch(() => ({}));
  const symbol = typeof body?.symbol === "string" ? body.symbol : null;

  const items = await prisma.watchlistItem.findMany({
    where: { userId, ...(symbol ? { symbol } : {}) },
  });

  const now = new Date();
  for (const item of items) {
    const quote = marketFeedStore.getQuote(item.symbol);
    if (!quote) continue;

    await prisma.lastSeenSnapshot.upsert({
      where: { watchlistItemId: item.id },
      update: { price: quote.price, timestamp: now },
      create: { watchlistItemId: item.id, price: quote.price, timestamp: now },
    });
  }

  return NextResponse.json({ ok: true, updated: items.length });
}
