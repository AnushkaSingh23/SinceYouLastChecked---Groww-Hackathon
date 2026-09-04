import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { marketFeedStore } from "@/lib/marketFeedStore";
import { getNSEMarketStatus } from "@/lib/marketHours";
import { NSE_40_UNIVERSE } from "@/lib/nseUniverse";

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "Not identified" }, { status: 401 });

  marketFeedStore.ensureStarted();

  const items = await prisma.watchlistItem.findMany({
    where: { userId },
    include: { lastSeen: true },
    orderBy: { addedAt: "asc" },
  });

  const cards = items.map((item) => {
    const lastSeen = item.lastSeen ? { price: item.lastSeen.price, timestamp: item.lastSeen.timestamp.getTime() } : null;
    const meta = NSE_40_UNIVERSE.find((s) => s.symbol === item.symbol);
    return {
      symbol: item.symbol,
      name: meta?.name ?? item.symbol,
      addedAt: item.addedAt,
      lastSeenAt: item.lastSeen?.timestamp ?? null,
      card: marketFeedStore.getAttentionCard(item.symbol, lastSeen),
    };
  });

  return NextResponse.json({
    marketStatus: getNSEMarketStatus(),
    lastPollAt: marketFeedStore.getLastPollAt(),
    items: cards,
  });
}

export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "Not identified" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol : "";

  if (!NSE_40_UNIVERSE.some((s) => s.symbol === symbol)) {
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

  await prisma.watchlistItem.deleteMany({ where: { userId, symbol } });
  return NextResponse.json({ ok: true });
}
