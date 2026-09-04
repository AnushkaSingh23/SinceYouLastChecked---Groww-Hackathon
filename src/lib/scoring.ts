// Combines volatility-adjusted price z-score, 52-week level breaks, and
// volume anomalies into a single explainable tier per symbol. Deliberately
// not a black-box score — every tier traces back to a plain-English reason,
// because "why was this flagged?" has to have a real answer.

import type { NSEQuote } from "./marketData";
import type { VolatilityResult } from "./volatility";
import { TRADING_DAY_MS } from "./volatility";
import type { VolumeAnomalyResult } from "./volumeAnomaly";

export type Tier = "CRITICAL" | "NOTABLE" | "QUIET";

const TIER_RANK: Record<Tier, number> = { QUIET: 0, NOTABLE: 1, CRITICAL: 2 };
const maxTier = (a: Tier, b: Tier): Tier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);
const escalate = (t: Tier): Tier => (t === "QUIET" ? "NOTABLE" : "CRITICAL");

// A z-score this large means "a move this big has historically been rare
// for this stock" — see PRD.md / DECISIONS.md for why this is
// volatility-relative rather than a flat % threshold.
const Z_CRITICAL = 3;
const Z_NOTABLE = 1.5;

// Floor on elapsed time used for the sqrt(time) scaling, so a near-instant
// re-check doesn't divide by ~0 and produce an absurd z-score. One poll
// interval's worth of trading-day-fraction is a reasonable minimum.
const MIN_ELAPSED_FRACTION = 20_000 / TRADING_DAY_MS;

export interface LastSeen {
  price: number;
  timestamp: number;
}

export interface AttentionCard {
  symbol: string;
  currentPrice: number;
  /** % change since last-seen price (or since previous close if never seen). */
  priceChangePct: number;
  zScore: number | null;
  tier: Tier;
  primaryReason: string;
  secondaryReasons: string[];
  isLevelBreak: boolean;
  isVolumeAnomaly: boolean;
  volatilityIsLive: boolean;
  dataFreshnessSec: number;
}

export function scoreSymbol(params: {
  quote: NSEQuote;
  now?: number;
  lastSeen: LastSeen | null;
  volatility: VolatilityResult;
  volumeAnomaly: VolumeAnomalyResult;
}): AttentionCard {
  const { quote, lastSeen, volatility, volumeAnomaly } = params;
  const now = params.now ?? Date.now();

  // No prior visit yet: compare against previous close, over "time elapsed
  // since today's session opened" as a stand-in reference window.
  const referencePrice = lastSeen?.price ?? quote.prevClose;
  const referenceTimestamp = lastSeen?.timestamp ?? quote.sourceTimestamp - (now - quote.sourceTimestamp);
  const elapsedMs = Math.max(now - referenceTimestamp, 0);

  const priceChangePct = referencePrice > 0 ? (quote.price - referencePrice) / referencePrice : 0;

  const elapsedTradingFraction = Math.max(elapsedMs / TRADING_DAY_MS, MIN_ELAPSED_FRACTION);
  const expectedMoveForElapsed = volatility.sigma * Math.sqrt(elapsedTradingFraction);
  const zScore = expectedMoveForElapsed > 0 ? Math.abs(priceChangePct) / expectedMoveForElapsed : null;

  const secondaryReasons: string[] = [];
  let tier: Tier = "QUIET";
  let primaryReason = "No notable activity since last check.";
  let signalCount = 0;

  if (zScore !== null) {
    if (zScore >= Z_CRITICAL) {
      tier = maxTier(tier, "CRITICAL");
      primaryReason = `Price moved ${(priceChangePct * 100).toFixed(1)}% — a ${zScore.toFixed(1)}σ move, unusual for this stock.`;
      signalCount++;
    } else if (zScore >= Z_NOTABLE) {
      tier = maxTier(tier, "NOTABLE");
      primaryReason = `Price moved ${(priceChangePct * 100).toFixed(1)}% (${zScore.toFixed(1)}σ for this stock).`;
      signalCount++;
    }
  }

  const isLevelBreak = quote.price >= quote.high52w || quote.price <= quote.low52w;
  if (isLevelBreak) {
    const direction = quote.price >= quote.high52w ? "high" : "low";
    const reason = `Crossed its 52-week ${direction} (₹${(direction === "high" ? quote.high52w : quote.low52w).toFixed(2)}).`;
    tier = maxTier(tier, "NOTABLE");
    if (primaryReason === "No notable activity since last check.") primaryReason = reason;
    else secondaryReasons.push(reason);
    signalCount++;
  }

  if (volumeAnomaly.isAnomaly && volumeAnomaly.ratio !== null) {
    const reason = `Volume is ${volumeAnomaly.ratio.toFixed(1)}x this stock's recent pace.`;
    tier = maxTier(tier, "NOTABLE");
    if (primaryReason === "No notable activity since last check.") primaryReason = reason;
    else secondaryReasons.push(reason);
    signalCount++;
  }

  // Multiple independent signals agreeing is more significant than any one
  // alone — escalate one level when 2+ signals fired together.
  if (signalCount >= 2) tier = escalate(tier);

  return {
    symbol: quote.symbol,
    currentPrice: quote.price,
    priceChangePct,
    zScore,
    tier,
    primaryReason,
    secondaryReasons,
    isLevelBreak,
    isVolumeAnomaly: volumeAnomaly.isAnomaly,
    volatilityIsLive: volatility.isLive,
    dataFreshnessSec: Math.max(0, Math.round((now - quote.sourceTimestamp) / 1000)),
  };
}
