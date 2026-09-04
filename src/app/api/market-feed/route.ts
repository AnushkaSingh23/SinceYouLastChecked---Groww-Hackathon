import { NextResponse } from "next/server";
import { marketFeedStore } from "@/lib/marketFeedStore";
import { getNSEMarketStatus } from "@/lib/marketHours";

export async function GET() {
  marketFeedStore.ensureStarted();

  return NextResponse.json({
    marketStatus: getNSEMarketStatus(),
    lastPollAt: marketFeedStore.getLastPollAt(),
    quotes: marketFeedStore.getSnapshot(),
  });
}
