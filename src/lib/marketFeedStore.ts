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
import { VolumeAnomalyTracker, classifyVolumeRatio } from "./volumeAnomaly";
import { scoreSymbol, type AttentionCard, type LastSeen } from "./scoring";
import { ShockInjector, type ShockOverride } from "./shockInjector";
import { getNSEMarketStatus } from "./marketHours";

// While the market is open, quotes move and 20s is a sensible cadence.
// While it's closed they cannot move, so polling at the same rate is
// ~172,800 requests/day at an undocumented, unauthenticated endpoint for
// data that is guaranteed identical — the fastest way to get rate-limited
// right before a demo. A slow heartbeat keeps the cache warm and the
// freshness display honest without the load.
const POLL_INTERVAL_OPEN_MS = 20_000;
const POLL_INTERVAL_CLOSED_MS = 5 * 60_000;

// Exponential backoff after a completely failed cycle, so a rate-limited or
// down feed isn't hammered at full rate (which is what keeps it rate-limited).
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;

type Listener = (quotes: NSEQuote[]) => void;

export interface FeedHealth {
  /** When a cycle last returned at least one quote. Null before the first success. */
  lastSuccessfulPollAt: number | null;
  /** When a cycle last completed, successful or not. */
  lastPollAt: number | null;
  consecutiveFailures: number;
  symbolsResolved: number;
  symbolsAttempted: number;
  /** True when the last cycle brought back nothing — the UI should say so rather than showing a confident timestamp. */
  degraded: boolean;
}

class MarketFeedStore {
  private quotes = new Map<string, NSEQuote>();
  private trackers = new Map<string, SymbolVolatilityTracker>();
  private volumeTrackers = new Map<string, VolumeAnomalyTracker>();
  /** Last sourceTimestamp fed to each volatility tracker, so a repeated quote isn't learned twice. */
  private lastTickAt = new Map<string, number>();
  private listeners = new Set<Listener>();
  private pollHandle: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private isPolling = false;
  private lastPollAt: number | null = null;
  private lastSuccessfulPollAt: number | null = null;
  private consecutiveFailures = 0;
  private symbolsResolved = 0;
  private symbolsAttempted = 0;
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
    // The timestamp the UI renders as "data as of ..." must be a time we
    // actually got data, not merely a time we tried. Reporting the attempt
    // made the banner confidently wrong exactly when the feed was broken.
    return this.lastSuccessfulPollAt;
  }

  getFeedHealth(): FeedHealth {
    return {
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastPollAt: this.lastPollAt,
      consecutiveFailures: this.consecutiveFailures,
      symbolsResolved: this.symbolsResolved,
      symbolsAttempted: this.symbolsAttempted,
      degraded: this.consecutiveFailures > 0,
    };
  }

  /** Scores one symbol against an optional last-seen snapshot. Returns null if we have no quote for it yet. */
  getAttentionCard(symbol: string, lastSeen: LastSeen | null): AttentionCard | null {
    const quote = this.quotes.get(symbol);
    const tracker = this.trackers.get(symbol);
    const volumeTracker = this.volumeTrackers.get(symbol);
    if (!quote || !tracker || !volumeTracker) return null;

    const shock = this.shocks.get(symbol);
    const effectiveQuote = shock?.priceOverridePct !== undefined
      ? {
          ...quote,
          price: quote.price * (1 + shock.priceOverridePct),
          // A simulated price move must not fabricate a 52-week break that
          // isn't real: an -6.2% overlay can push a healthy stock past its
          // genuine 52-week low and produce "Crossed its 52-week low (₹X)"
          // — a false statement about a real, named, publicly traded company,
          // in a reason string that (unlike the card) carries no SIMULATED
          // marker. Keep each bound only when the REAL price already broke it.
          high52w: quote.high52w !== null && quote.price >= quote.high52w ? quote.high52w : null,
          low52w: quote.low52w !== null && quote.price <= quote.low52w ? quote.low52w : null,
        }
      : quote;
    const effectiveVolumeAnomaly = shock?.volumeAnomalyRatio !== undefined
      ? {
          // Grade a simulated ratio on exactly the same scale as a real one
          // — an injected 1.2x shouldn't be called an anomaly when the app's
          // own definition of one starts at 1.5x.
          isAnomaly: classifyVolumeRatio(shock.volumeAnomalyRatio) !== "NORMAL",
          level: classifyVolumeRatio(shock.volumeAnomalyRatio),
          ratio: shock.volumeAnomalyRatio,
          // A simulated event is a deliberate, confirmed one — it shouldn't
          // have to wait two polls to count, the way a real reading does.
          sustained: true,
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

  private async poll(): Promise<void> {
    // The whole body is wrapped: this is called fire-and-forget from a timer,
    // and on modern Node an unhandled rejection terminates the process. A
    // transient fetch failure must not be able to take the server down.
    try {
      const symbols = NSE_40_UNIVERSE.map((s) => s.symbol);
      this.symbolsAttempted = symbols.length;

      const fresh = await fetchNSEUniverseQuotes(symbols);
      this.symbolsResolved = fresh.length;

      if (fresh.length === 0) {
        this.consecutiveFailures++;
      } else {
        this.consecutiveFailures = 0;
        this.lastSuccessfulPollAt = Date.now();
      }

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
        // Monotonicity guard. Requests within a cycle finish out of order,
        // and a slow response can land after a fast one from the next
        // cycle — writing older data over newer makes prices visibly jump
        // backwards and lets a mark-seen baseline against a stale price.
        const existing = this.quotes.get(q.symbol);
        if (existing && q.sourceTimestamp < existing.sourceTimestamp) continue;
        this.quotes.set(q.symbol, q);

        if (!marketOpen) continue;

        // Only learn from a genuinely new print. When a symbol hasn't
        // traded, Yahoo returns the same quote with the same
        // regularMarketTime every cycle; recording each as a fresh tick
        // buries the real returns under zeros, which both understates
        // sigma (making ordinary moves read as CRITICAL) and corrupts the
        // observed tick spacing the daily-equivalent scaling depends on.
        const lastTick = this.lastTickAt.get(q.symbol);
        if (lastTick === undefined || q.sourceTimestamp > lastTick) {
          this.lastTickAt.set(q.symbol, q.sourceTimestamp);
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
        // callers below.
        try {
          listener(snapshot);
        } catch {
          // Swallow — a broken listener is a client-connection problem, not
          // a reason to break this poll cycle for everyone else.
        }
      }
    } catch {
      this.consecutiveFailures++;
      this.lastPollAt = Date.now();
    }
  }

  /** How long to wait before the next cycle, given market state and recent failures. */
  private nextDelayMs(): number {
    if (this.consecutiveFailures > 0) {
      return Math.min(BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1), BACKOFF_MAX_MS);
    }
    return getNSEMarketStatus().isOpen ? POLL_INTERVAL_OPEN_MS : POLL_INTERVAL_CLOSED_MS;
  }

  /**
   * Self-scheduling loop rather than setInterval: a slow cycle must not have
   * a second one fire on top of it. With 40 sequential-batch fetches against
   * a slow endpoint, overlapping cycles stack up and multiply load on the
   * very endpoint that's already struggling.
   */
  private scheduleNext(): void {
    if (this.stopped) return;
    const handle = setTimeout(() => {
      void this.runCycle();
    }, this.nextDelayMs());
    // Don't hold the process open purely for the poll timer. Cast because
    // `unref` is a Node-only extension and this file is typechecked with the
    // DOM lib in scope, where setTimeout returns a plain number.
    (handle as unknown as { unref?: () => void }).unref?.();
    this.pollHandle = handle;
  }

  private async runCycle(): Promise<void> {
    if (this.isPolling) {
      this.scheduleNext();
      return;
    }
    this.isPolling = true;
    try {
      await this.poll();
    } finally {
      this.isPolling = false;
      this.scheduleNext();
    }
  }

  ensureStarted() {
    if (this.pollHandle || this.isPolling) return;
    this.stopped = false;
    // Fire immediately so the first request doesn't wait a full interval.
    void this.runCycle();
  }

  /** Used by tests/teardown; the app itself runs the loop for the process lifetime. */
  stop() {
    this.stopped = true;
    if (this.pollHandle) clearTimeout(this.pollHandle);
    this.pollHandle = null;
  }
}

declare global {

  var __marketFeedStore: MarketFeedStore | undefined;
}

export const marketFeedStore = globalThis.__marketFeedStore ?? new MarketFeedStore();
globalThis.__marketFeedStore = marketFeedStore;
