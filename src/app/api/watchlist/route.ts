import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { marketFeedStore } from "@/lib/marketFeedStore";
import { getNSEMarketStatus } from "@/lib/marketHours";
import { NSE_40_UNIVERSE } from "@/lib/nseUniverse";
import { getLongTermTrend } from "@/lib/longTermTrend";
import { fetchNSEQuote } from "@/lib/marketData";

// The curated set is no longer the ceiling on what can be watched — it is a
// fallback for display names on items added before names were stored.
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

  // Register everything this user watches for polling. Symbols are added on
  // demand now, so a stock added on another device — or before this process
  // started — begins being polled as soon as someone looks at it.
  marketFeedStore.ensureTracked(items.map((i) => i.symbol));

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
            benchmarkSymbol: item.lastSeen.benchmarkSymbol,
            benchmarkPrice: item.lastSeen.benchmarkPrice,
          }
        : null;
      const meta = SYMBOL_META.get(item.symbol);
      return {
        symbol: item.symbol,
        // Stored name first; curated table for older rows; bare ticker last.
        name: item.name ?? meta?.name ?? item.symbol.replace(/\.NS$/, ""),
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

/** Any NSE ticker, e.g. TATAPOWER.NS. Shape-checked before it reaches the network. */
const NSE_SYMBOL = /^[A-Z0-9&._-]{1,20}\.NS$/;

export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "Not identified" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const providedName = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";

  if (!NSE_SYMBOL.test(symbol)) {
    return NextResponse.json({ error: "Not a valid NSE symbol" }, { status: 400 });
  }

  // Validate against the feed rather than a hardcoded list: if the data source
  // returns a real quote, it is a real tradeable symbol and this app can score
  // it. That is what lifts the watchlist from 40 tickers to the whole exchange.
  // A cached quote counts — no need to re-fetch something already being polled.
  const known = marketFeedStore.getQuote(symbol) ?? (await fetchNSEQuote(symbol));
  if (!known) {
    return NextResponse.json(
      { error: "That symbol didn't return any market data — check the ticker." },
      { status: 400 }
    );
  }

  const name = providedName || SYMBOL_META.get(symbol)?.name || symbol.replace(/\.NS$/, "");

  await prisma.watchlistItem.upsert({
    where: { userId_symbol: { userId, symbol } },
    update: { name },
    create: { userId, symbol, name },
  });

  // Start polling it immediately and derive its real volatility seed, so the
  // card has live data by the time the user looks at it.
  marketFeedStore.ensureTracked([symbol]);

  return NextResponse.json({ ok: true, symbol, name });
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
