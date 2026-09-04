// Server-side singleton: holds the live quote cache + volatility trackers
// for the whole NSE universe, and runs the polling loop that keeps them
// fresh. One shared poll per symbol regardless of how many browser tabs are
// watching — see ARCHITECTURE.md.
//
// Guarded on globalThis so Next.js dev-mode hot-reload doesn't spin up a
// second interval on every file save (the same pattern used for a Prisma
// client singleton in Next.js apps).

import { fetchNSEUniverseQuotes, type NSEQuote } from "./marketData";
import { NSE_40_UNIVERSE } from "./nseUniverse";
import { SymbolVolatilityTracker } from "./volatility";
import { VolumeAnomalyTracker } from "./volumeAnomaly";
import { scoreSymbol, type AttentionCard, type LastSeen } from "./scoring";

const POLL_INTERVAL_MS = 20_000;

type Listener = (quotes: NSEQuote[]) => void;

class MarketFeedStore {
  private quotes = new Map<string, NSEQuote>();
  private trackers = new Map<string, SymbolVolatilityTracker>();
  private volumeTrackers = new Map<string, VolumeAnomalyTracker>();
  private listeners = new Set<Listener>();
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private lastPollAt: number | null = null;

  constructor() {
    for (const s of NSE_40_UNIVERSE) {
      this.trackers.set(s.symbol, new SymbolVolatilityTracker(s.symbol));
      this.volumeTrackers.set(s.symbol, new VolumeAnomalyTracker(s.symbol));
    }
  }

  getTracker(symbol: string): SymbolVolatilityTracker | undefined {
    return this.trackers.get(symbol);
  }

  getVolumeTracker(symbol: string): VolumeAnomalyTracker | undefined {
    return this.volumeTrackers.get(symbol);
  }

  getSnapshot(): NSEQuote[] {
    return Array.from(this.quotes.values());
  }

  getLastPollAt(): number | null {
    return this.lastPollAt;
  }

  /** Scores one symbol against an optional last-seen snapshot. Returns null if we have no quote for it yet. */
  getAttentionCard(symbol: string, lastSeen: LastSeen | null): AttentionCard | null {
    const quote = this.quotes.get(symbol);
    const tracker = this.trackers.get(symbol);
    const volumeTracker = this.volumeTrackers.get(symbol);
    if (!quote || !tracker || !volumeTracker) return null;

    return scoreSymbol({
      quote,
      lastSeen,
      volatility: tracker.getEffectiveVolatility(),
      volumeAnomaly: volumeTracker.getLastResult(),
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async poll() {
    const fresh = await fetchNSEUniverseQuotes();
    for (const q of fresh) {
      this.quotes.set(q.symbol, q);
      this.trackers.get(q.symbol)?.addTick(q.price, q.sourceTimestamp);
      this.volumeTrackers.get(q.symbol)?.addReading(q.volume);
    }
    this.lastPollAt = Date.now();

    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  ensureStarted() {
    if (this.pollHandle) return;
    // Fire immediately so the first request doesn't wait a full interval.
    void this.poll();
    this.pollHandle = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __marketFeedStore: MarketFeedStore | undefined;
}

export const marketFeedStore = globalThis.__marketFeedStore ?? new MarketFeedStore();
globalThis.__marketFeedStore = marketFeedStore;
