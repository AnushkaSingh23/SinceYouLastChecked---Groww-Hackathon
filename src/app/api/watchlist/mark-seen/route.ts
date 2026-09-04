import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { marketFeedStore } from "@/lib/marketFeedStore";

// Marks one symbol (or the whole watchlist, if no symbol given) as seen at
// its current live state — this is what flattens tiers back to QUIET and is
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

  // Build every write first, then commit them together. A partial failure
  // halfway through a sequential loop leaves a half-marked baseline, which
  // for this product means a permanently inconsistent "since you last
  // checked" reading for the symbols that didn't make it.
  const pending: { itemId: string; price: number; levelBreak: boolean; volumeRatio: number | null }[] = [];
  let skipped = 0;

  for (const item of items) {
    // Score the symbol against its own current state to capture what the
    // user is actually acknowledging. Price alone isn't enough: a stock
    // sitting at its 52-week high or in a volume surge would otherwise stay
    // flagged forever no matter how many times it's marked seen, and the
    // "N need your attention" headline would never reach zero.
    //
    // Note this deliberately records the card's price, which reflects an
    // active dev shock if there is one. "Seen" means "seen what was on the
    // screen" — acknowledging a simulated -6% card against the real
    // unshocked price would leave it flagged, i.e. the button visibly
    // wouldn't work during the exact scenario it's demoed in.
    const card = marketFeedStore.getAttentionCard(item.symbol, null);
    if (!card) {
      skipped++;
      continue;
    }

    pending.push({
      itemId: item.id,
      price: card.currentPrice,
      levelBreak: card.isLevelBreak,
      volumeRatio: card.volumeRatio,
    });
  }

  const writes = pending.map((p) =>
    prisma.lastSeenSnapshot.upsert({
      where: { watchlistItemId: p.itemId },
      update: { price: p.price, timestamp: now, levelBreak: p.levelBreak, volumeRatio: p.volumeRatio },
      create: {
        watchlistItemId: p.itemId,
        price: p.price,
        timestamp: now,
        levelBreak: p.levelBreak,
        volumeRatio: p.volumeRatio,
      },
    })
  );

  if (writes.length > 0) await prisma.$transaction(writes);

  // Only count items that actually got a snapshot written — items with no
  // cached quote yet (cold start, or a symbol whose fetch failed this
  // cycle) are skipped above, and the response shouldn't claim otherwise.
  // `skipped` is returned so the UI can tell the user their click was a
  // partial no-op instead of silently doing nothing.
  return NextResponse.json({ ok: true, updated: writes.length, skipped });
}
