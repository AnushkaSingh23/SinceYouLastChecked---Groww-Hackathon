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

// Display/storage ceiling. The raw math is honest — a large real move over
// a very short elapsed window (e.g. the dev shock injector fired seconds
// after "mark as seen") genuinely computes as a huge sigma value under the
// sqrt(time) model, that's not a division-by-near-zero bug (sigma itself is
// fine; see ERRORS.md). But nothing past ~6σ is more informative than
// "extremely unusual" to a human reading the card, and an uncapped number
// like "89.8σ" reads as broken math to anyone reviewing it, not as a
// meaningful signal. Six sigma is also a recognizable, standard threshold
// for "practically impossible under normal variation."
const MAX_DISPLAY_Z = 6;

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
  /** True if zScore hit the display ceiling (MAX_DISPLAY_Z) — the real move was even larger. */
  zScoreClamped: boolean;
  tier: Tier;
  primaryReason: string;
  secondaryReasons: string[];
  isLevelBreak: boolean;
  isVolumeAnomaly: boolean;
  volatilityIsLive: boolean;
  dataFreshnessSec: number;
  /** Set by marketFeedStore when a dev shock override is active for this symbol — scoring.ts itself doesn't know about shocks. */
  isSimulated?: boolean;
  newsHeadline?: string;
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

  // "Never checked before" has no real elapsed-time reference to scale
  // against (we don't know when prevClose was actually set, and guessing
  // produces nonsense — a first-ever view of a symbol previously showed as
  // a 36-sigma "CRITICAL" move because a tiny guessed elapsed time blew up
  // the z-score, see ERRORS.md). So a first-time view gets no z-score at
  // all: just today's plain change, tier QUIET unless an independent
  // signal (level break / volume) fires. Tiering is about "what changed
  // since YOU checked" — if you've never checked, there's nothing to diff.
  const priceChangePct = lastSeen
    ? (quote.price - lastSeen.price) / lastSeen.price
    : quote.changePct / 100;

  let zScore: number | null = null;
  let zScoreClamped = false;
  if (lastSeen) {
    const elapsedMs = Math.max(now - lastSeen.timestamp, 0);
    const elapsedTradingFraction = Math.max(elapsedMs / TRADING_DAY_MS, MIN_ELAPSED_FRACTION);
    const expectedMoveForElapsed = volatility.sigma * Math.sqrt(elapsedTradingFraction);
    const rawZ = expectedMoveForElapsed > 0 ? Math.abs(priceChangePct) / expectedMoveForElapsed : null;
    if (rawZ !== null && rawZ > MAX_DISPLAY_Z) {
      zScore = MAX_DISPLAY_Z;
      zScoreClamped = true;
    } else {
      zScore = rawZ;
    }
  }
  const zScoreLabel = (z: number) => `${z.toFixed(1)}σ${zScoreClamped ? "+" : ""}`;

  const secondaryReasons: string[] = [];
  let tier: Tier = "QUIET";
  let primaryReason = lastSeen
    ? "No notable activity since last check."
    : `Just added — ${quote.changePct >= 0 ? "up" : "down"} ${Math.abs(quote.changePct).toFixed(1)}% today.`;
  const defaultReason = primaryReason;
  let signalCount = 0;

  if (zScore !== null) {
    if (zScore >= Z_CRITICAL) {
      tier = maxTier(tier, "CRITICAL");
      primaryReason = `Price moved ${(priceChangePct * 100).toFixed(1)}% — a ${zScoreLabel(zScore)} move, unusual for this stock.`;
      signalCount++;
    } else if (zScore >= Z_NOTABLE) {
      tier = maxTier(tier, "NOTABLE");
      primaryReason = `Price moved ${(priceChangePct * 100).toFixed(1)}% (${zScoreLabel(zScore)} for this stock).`;
      signalCount++;
    }
  }

  const isLevelBreak = quote.price >= quote.high52w || quote.price <= quote.low52w;
  if (isLevelBreak) {
    const direction = quote.price >= quote.high52w ? "high" : "low";
    const reason = `Crossed its 52-week ${direction} (₹${(direction === "high" ? quote.high52w : quote.low52w).toFixed(2)}).`;
    tier = maxTier(tier, "NOTABLE");
    if (primaryReason === defaultReason) primaryReason = reason;
    else secondaryReasons.push(reason);
    signalCount++;
  }

  if (volumeAnomaly.isAnomaly && volumeAnomaly.ratio !== null) {
    const reason = `Volume is ${volumeAnomaly.ratio.toFixed(1)}x this stock's recent pace.`;
    tier = maxTier(tier, "NOTABLE");
    if (primaryReason === defaultReason) primaryReason = reason;
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
    zScoreClamped,
    tier,
    primaryReason,
    secondaryReasons,
    isLevelBreak,
    isVolumeAnomaly: volumeAnomaly.isAnomaly,
    volatilityIsLive: volatility.isLive,
    dataFreshnessSec: Math.max(0, Math.round((now - quote.sourceTimestamp) / 1000)),
  };
}
