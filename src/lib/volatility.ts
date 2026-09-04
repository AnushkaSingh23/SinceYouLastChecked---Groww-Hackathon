// Seeded + rolling volatility engine.
// No historical data dependency: starts from a hardcoded seed tier per symbol
// (sourced from nseUniverse.ts, the single source of truth for the ticker
// universe), switches to live-observed volatility once enough ticks have
// arrived in this session.
//
// Everything here is expressed as a DAILY-equivalent sigma. Ticks arrive
// roughly every ~20s (the poller's interval, see marketFeedStore.ts), so a
// raw stdev of tick-to-tick returns is a 20-second-scale number — comparing
// that directly against a multi-hour or multi-day "since you last checked"
// move would make almost any move look like a huge outlier. Volatility
// scales with the square root of elapsed time (the same math behind
// annualizing a daily volatility), so the live tick-level estimate is scaled
// up to a daily-equivalent using the actual observed spacing between ticks.
// scoring.ts then scales this daily sigma back down/up to whatever the
// user's actual elapsed time since last-seen is.

import { NSE_40_UNIVERSE } from "./nseUniverse";
import { TRADING_DAY_MS } from "./marketHours";

// One canonical definition of a session's length, owned by marketHours.ts
// (which also knows *which* wall-clock spans count as trading time).
// Re-exported here because this module is where the daily-equivalent scaling
// happens, so callers reading this file expect to find it.
export { TRADING_DAY_MS };

const SEED_SIGMA_BY_SYMBOL: Record<string, number> = Object.fromEntries(
  NSE_40_UNIVERSE.map((s) => [s.symbol, s.baseSigma])
);

const DEFAULT_SEED_SIGMA = 0.015;
const MIN_TICKS_FOR_LIVE_VOL = 10;

export interface PriceTick {
  price: number;
  timestamp: number;
}

export interface VolatilityResult {
  /** Daily-equivalent sigma, e.g. 0.02 = 2% expected daily move. */
  sigma: number;
  isLive: boolean;
}

export class SymbolVolatilityTracker {
  private tickBuffer: PriceTick[] = [];
  private readonly maxBufferSize = 50;

  constructor(public readonly symbol: string) {}

  addTick(price: number, timestamp: number = Date.now()): void {
    this.tickBuffer.push({ price, timestamp });
    if (this.tickBuffer.length > this.maxBufferSize) {
      this.tickBuffer.shift();
    }
  }

  get tickCount(): number {
    return this.tickBuffer.length;
  }

  get latestTick(): PriceTick | undefined {
    return this.tickBuffer[this.tickBuffer.length - 1];
  }

  private seedSigma(): number {
    return SEED_SIGMA_BY_SYMBOL[this.symbol] ?? DEFAULT_SEED_SIGMA;
  }

  /**
   * Daily-equivalent standard deviation of returns, computed live once
   * enough ticks exist; otherwise the hardcoded seed for this symbol.
   */
  getEffectiveVolatility(): VolatilityResult {
    if (this.tickBuffer.length < MIN_TICKS_FOR_LIVE_VOL) {
      return { sigma: this.seedSigma(), isLive: false };
    }

    const returns: number[] = [];
    let totalIntervalMs = 0;
    for (let i = 1; i < this.tickBuffer.length; i++) {
      const prev = this.tickBuffer[i - 1];
      const curr = this.tickBuffer[i];
      returns.push((curr.price - prev.price) / prev.price);
      totalIntervalMs += curr.timestamp - prev.timestamp;
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    // Sample variance (n-1) — standard choice for a volatility estimate from a sample.
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const perTickSigma = Math.sqrt(variance);

    const avgIntervalMs = totalIntervalMs / returns.length;
    // Guard against a degenerate/zero interval (e.g. duplicate timestamps).
    const ticksPerTradingDay = avgIntervalMs > 0 ? TRADING_DAY_MS / avgIntervalMs : 1;
    const dailySigma = perTickSigma * Math.sqrt(ticksPerTradingDay);

    // Guard against near-zero variance on an idle feed (would make z-scores explode).
    return {
      sigma: dailySigma > 0.0001 ? dailySigma : this.seedSigma(),
      isLive: dailySigma > 0.0001,
    };
  }
}
