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
import { VolumeAnomalyTracker, ANOMALY_RATIO_THRESHOLD } from "./volumeAnomaly";
import { scoreSymbol, type AttentionCard, type LastSeen } from "./scoring";
import { ShockInjector, type ShockOverride } from "./shockInjector";
import { getNSEMarketStatus } from "./marketHours";

const POLL_INTERVAL_MS = 20_000;

type Listener = (quotes: NSEQuote[]) => void;

class MarketFeedStore {
  private quotes = new Map<string, NSEQuote>();
  private trackers = new Map<string, SymbolVolatilityTracker>();
  private volumeTrackers = new Map<string, VolumeAnomalyTracker>();
  private listeners = new Set<Listener>();
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private lastPollAt: number | null = null;
  private shocks = new ShockInjector();

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

  getQuote(symbol: string): NSEQuote | undefined {
    return this.quotes.get(symbol);
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

    const shock = this.shocks.get(symbol);
    const effectiveQuote = shock?.priceOverridePct !== undefined
      ? { ...quote, price: quote.price * (1 + shock.priceOverridePct) }
      : quote;
    const effectiveVolumeAnomaly = shock?.volumeAnomalyRatio !== undefined
      ? {
          // Classify a simulated ratio the same way a real one would be —
          // an injected 1.2x shouldn't be called "an anomaly" when the
          // app's own definition requires >= 2.5x for real data.
          isAnomaly: shock.volumeAnomalyRatio >= ANOMALY_RATIO_THRESHOLD,
          ratio: shock.volumeAnomalyRatio,
          ratioClamped: false,
          isLive: true,
        }
      : volumeTracker.getLastResult();

    const card = scoreSymbol({
      quote: effectiveQuote,
      lastSeen,
      volatility: tracker.getEffectiveVolatility(),
      volumeAnomaly: effectiveVolumeAnomaly,
    });

    if (shock) {
      card.isSimulated = true;
      if (shock.headline) card.newsHeadline = shock.headline;
    }
    return card;
  }

  injectShock(symbol: string, override: Omit<ShockOverride, "injectedAt">): void {
    this.shocks.inject(symbol, override);
  }

  clearShock(symbol: string): void {
    this.shocks.clear(symbol);
  }

  clearAllShocks(): void {
    this.shocks.clearAll();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async poll() {
    const fresh = await fetchNSEUniverseQuotes();
    // Only feed the volatility/volume trackers while the market is
    // actually open. This process is designed to survive across this
    // hackathon's real multi-day gap between trading sessions (Friday
    // afternoon, then Monday morning — see marketHours.ts) rather than
    // being restarted each time. Feeding near-zero deltas/ticks from a
    // closed market into the rolling baselines would deflate them over
    // the weekend, producing a spurious spike the moment real trading
    // resumes. The quote cache itself still refreshes regardless (prices
    // don't change while closed anyway, and staleness display should
    // stay accurate either way).
    const marketOpen = getNSEMarketStatus().isOpen;
    for (const q of fresh) {
      this.quotes.set(q.symbol, q);
      if (marketOpen) {
        this.trackers.get(q.symbol)?.addTick(q.price, q.sourceTimestamp);
        this.volumeTrackers.get(q.symbol)?.addReading(q.volume);
      }
    }
    this.lastPollAt = Date.now();

    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      // One dead/erroring SSE listener (client disconnected but the abort
      // event hasn't fired yet, so it's still in the set) must not stop
      // delivery to every other listener registered after it, and must
      // not become an unhandled rejection from the fire-and-forget
      // `void this.poll()` callers below.
      try {
        listener(snapshot);
      } catch {
        // Swallow — a broken listener is a client-connection problem, not
        // a reason to break this poll cycle for everyone else.
      }
    }
  }

  ensureStarted() {
    if (this.pollHandle) return;
    // Fire immediately so the first request doesn't wait a full interval.
    void this.poll();
    this.pollHandle = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }
}

declare global {
   
  var __marketFeedStore: MarketFeedStore | undefined;
}

export const marketFeedStore = globalThis.__marketFeedStore ?? new MarketFeedStore();
globalThis.__marketFeedStore = marketFeedStore;
