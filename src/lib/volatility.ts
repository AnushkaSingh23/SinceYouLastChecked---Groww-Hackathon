// Seeded + rolling volatility engine.
// No historical data dependency: starts from a hardcoded seed tier per symbol
// (sourced from nseUniverse.ts, the single source of truth for the ticker
// universe), switches to live-observed volatility once enough ticks have
// arrived in this session.

import { NSE_40_UNIVERSE } from "./nseUniverse";

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
   * Standard deviation of tick-to-tick returns once enough live ticks exist,
   * otherwise the hardcoded seed for this symbol (or a default).
   */
  getEffectiveVolatility(): VolatilityResult {
    if (this.tickBuffer.length < MIN_TICKS_FOR_LIVE_VOL) {
      return { sigma: this.seedSigma(), isLive: false };
    }

    const returns: number[] = [];
    for (let i = 1; i < this.tickBuffer.length; i++) {
      const prev = this.tickBuffer[i - 1].price;
      const curr = this.tickBuffer[i].price;
      returns.push((curr - prev) / prev);
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    // Sample variance (n-1) — standard choice for a volatility estimate from a sample.
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const liveSigma = Math.sqrt(variance);

    // Guard against near-zero variance on an idle feed (would make z-scores explode).
    return {
      sigma: liveSigma > 0.0001 ? liveSigma : this.seedSigma(),
      isLive: liveSigma > 0.0001,
    };
  }
}
