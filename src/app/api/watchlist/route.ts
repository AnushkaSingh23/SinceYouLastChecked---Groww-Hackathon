import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { marketFeedStore } from "@/lib/marketFeedStore";
import { getNSEMarketStatus } from "@/lib/marketHours";
import { NSE_40_UNIVERSE } from "@/lib/nseUniverse";
import { getLongTermTrend } from "@/lib/longTermTrend";

// Hoisted to module scope: a `.find()` inside the per-item `.map()` below is
// O(n·m) on every request for a lookup whose input never changes.
const SYMBOL_META = new Map(NSE_40_UNIVERSE.map((s) => [s.symbol, s]));

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "Not identified" }, { status: 401 });

  marketFeedStore.ensureStarted();

  const items = await prisma.watchlistItem.findMany({
    where: { userId },
    include: { lastSeen: true },
    orderBy: { addedAt: "asc" },
  });

  // Long-term trend is cached for a day and fetched independently of the
  // live poll loop — a secondary feature, kept off the primary "since you
  // last checked" hot path entirely (see longTermTrend.ts).
  const cards = await Promise.all(
    items.map(async (item) => {
      // The full acknowledged state, not just the price: scoring.ts diffs
      // level-break and volume against what the user already saw, so that
      // "mark all as seen" actually returns the list to QUIET instead of
      // leaving a stock pinned at its 52-week high flagged forever.
      const lastSeen = item.lastSeen
        ? {
            price: item.lastSeen.price,
            timestamp: item.lastSeen.timestamp.getTime(),
            levelBreak: item.lastSeen.levelBreak,
            volumeRatio: item.lastSeen.volumeRatio,
          }
        : null;
      const meta = SYMBOL_META.get(item.symbol);
      return {
        symbol: item.symbol,
        name: meta?.name ?? item.symbol,
        sector: meta?.sector ?? null,
        addedAt: item.addedAt,
        lastSeenAt: item.lastSeen?.timestamp ?? null,
        card: marketFeedStore.getAttentionCard(item.symbol, lastSeen),
        trend: await getLongTermTrend(item.symbol),
      };
    })
  );

  return NextResponse.json({
    marketStatus: getNSEMarketStatus(),
    lastPollAt: marketFeedStore.getLastPollAt(),
    feedHealth: marketFeedStore.getFeedHealth(),
    items: cards,
  });
}

export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "Not identified" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol : "";

  if (!SYMBOL_META.has(symbol)) {
    return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });
  }

  await prisma.watchlistItem.upsert({
    where: { userId_symbol: { userId, symbol } },
    update: {},
    create: { userId, symbol },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "Not identified" }, { status: 401 });

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "";

  // Report what actually happened. Returning `{ ok: true }` for a symbol
  // that was never on the list makes a client-side bug invisible.
  const { count } = await prisma.watchlistItem.deleteMany({ where: { userId, symbol } });
  return NextResponse.json({ ok: true, removed: count });
}
