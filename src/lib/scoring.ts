// Combines volatility-adjusted price z-score, 52-week level breaks, and
// volume anomalies into a single explainable tier per symbol. Deliberately
// not a black-box score — every tier traces back to a plain-English reason,
// because "why was this flagged?" has to have a real answer.

import type { NSEQuote } from "./marketData";
import type { VolatilityResult } from "./volatility";
import { TRADING_DAY_MS, tradingElapsedBetween } from "./marketHours";
import {
  classifyVolumeRatio,
  VOLUME_ELEVATED_RATIO,
  VOLUME_SURGE_RATIO,
  type VolumeAnomalyResult,
  type VolumeLevel,
} from "./volumeAnomaly";

// NEW is its own state, not a degenerate case of the tier system. A symbol
// the user has never checked has no "since you last checked" baseline —
// showing it as CRITICAL/NOTABLE would mean the badge is driven entirely by
// signals that have nothing to do with the user's own history (a real
// 52-week high plus real volume activity can both be true on a stock added
// three seconds ago). That's a false alarm on day one, exactly contrary to
// the point of the product. See DECISIONS.md.
export type Tier = "CRITICAL" | "NOTABLE" | "QUIET" | "NEW";

const TIER_RANK: Record<Tier, number> = { QUIET: 0, NEW: 0, NOTABLE: 1, CRITICAL: 2 };
const maxTier = (a: Tier, b: Tier): Tier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);
const escalate = (t: Tier): Tier => (t === "QUIET" || t === "NEW" ? "NOTABLE" : "CRITICAL");

// A z-score this large means "a move this big has historically been rare
// for this stock" — see PRD.md / DECISIONS.md for why this is
// volatility-relative rather than a flat % threshold.
const Z_CRITICAL = 3;
const Z_NOTABLE = 1.5;

/**
 * Exported so the UI can show the same numbers it scores with, rather than
 * hardcoding a second copy that silently drifts out of sync with the engine.
 */
export const SCORING_THRESHOLDS = {
  zNotable: Z_NOTABLE,
  zCritical: Z_CRITICAL,
  volumeElevated: VOLUME_ELEVATED_RATIO,
  volumeSurge: VOLUME_SURGE_RATIO,
} as const;

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

// What one overnight (or weekend) closure is worth in expected variance.
// A closed market contains zero trading minutes but is NOT zero-risk —
// prices reopen on news that broke while it was shut, which is exactly why
// gaps happen. The textbook treatment charges a closed session a fixed
// fraction of a normal trading day rather than nothing; 0.2 sits in the
// usual empirical 0.15-0.25 range. Without this, a check made at 9:16 AM
// against a 6 PM baseline would see ~1 minute of elapsed trading time and
// call every ordinary opening tick a 10-sigma event.
const OVERNIGHT_GAP_TRADING_FRACTION = 0.2;

// How far past an already-acknowledged volume ratio the live ratio has to go
// before it counts as news again. Without this, "mark all as seen" during a
// surge leaves the card pinned at its tier until the surge ends — the user
// acknowledges it and the badge ignores them, which is the precise failure
// this product exists to avoid.
const VOLUME_REFLAG_FACTOR = 1.25;

// How much each signal contributes to escalation.
//
// Volume is the one that carries variable weight, so that more volume is
// genuinely a stronger signal rather than a boolean that flips once:
//
//   under 1.5x            0   nothing to say
//   1.5x-3x (ELEVATED)    1   -> NOTABLE on its own
//   3x+ for one poll      1   -> NOTABLE on its own
//   3x+ and holding       2   -> QUIET -> NOTABLE -> CRITICAL on its own
//
// A confirmed surge is the only single signal besides an extreme price move
// that reaches CRITICAL alone. Requiring it to hold for two polls matters:
// NSE volume is U-shaped, so a single 20-second print at 3x is routine into
// the close and would otherwise paint most of the list red every afternoon.
//
// Every other signal keeps exactly the weight it always had, so no
// combination that used to escalate has stopped escalating.
const WEIGHT_PRICE = 1;
const WEIGHT_LEVEL_BREAK = 1;
function volumeWeight(level: VolumeLevel, sustained: boolean): number {
  if (level === "NORMAL") return 0;
  if (level === "SURGE" && sustained) return 2;
  return 1;
}

/** Total signal weight at which the tier is bumped one level. */
const ESCALATION_WEIGHT = 2;

// Below this the index barely moved, so it explains nothing and no
// market-relative claim should be made either way.
const BENCHMARK_MEANINGFUL_MOVE = 0.003; // 0.3%

// A move is "market-driven" when the index explains most of it — i.e. what is
// left after removing the market is at most this fraction of the original move.
// 0.35 means the index accounts for roughly two thirds or more.
//
// Deliberately a PROPORTION, not a z-score on the residual. Judging the
// leftover by z makes the answer depend on how long you were away: over a
// 20-second window a 0.2% divergence is already >5 sigma, so nothing would ever
// be called market-driven on a short visit — while over a week almost
// everything would be. "How much of this was the market?" is a question about
// the decomposition of the move, not about elapsed time, so it should give the
// same answer either way.
const MARKET_DRIVEN_RESIDUAL_FRACTION = 0.35;

/**
 * The benchmark index's move over exactly the same window as the stock's.
 * Absent when the index level wasn't recorded at acknowledgement time.
 */
export interface BenchmarkContext {
  symbol: string;
  name: string;
  /** Fractional change since the user last checked, e.g. -0.029 for -2.9%. */
  changePct: number;
}

export interface LastSeen {
  price: number;
  timestamp: number;
  /**
   * Was this symbol already sitting at a 52-week bound, and how busy was it,
   * the last time the user acknowledged it? Optional so pure-logic callers
   * (and the smoke tests) can omit them; when absent, every signal is treated
   * as new, which is the old behaviour.
   */
  levelBreak?: boolean;
  volumeRatio?: number | null;
  /** Benchmark index level when acknowledged, so the comparison spans the same window. */
  benchmarkSymbol?: string | null;
  benchmarkPrice?: number | null;
}

export interface AttentionCard {
  symbol: string;
  currentPrice: number;
  /** % change since last-seen price (or since previous close if never seen). */
  priceChangePct: number;
  /** Signed ₹ change since the same baseline as priceChangePct. */
  priceChangeAbs: number;
  /** The price this card is diffing against — the app is named after this number, so it gets shown. Null when never seen. */
  lastSeenPrice: number | null;
  /** Epoch ms of the user's last acknowledgement, or null. */
  lastSeenAt: number | null;
  /** Open-market milliseconds the user was actually away for — the real denominator behind the z-score. */
  tradingElapsedMs: number | null;
  /** How many market opens happened while they were away (0 = same session). */
  sessionsMissed: number;
  zScore: number | null;
  /** True if zScore hit the display ceiling (MAX_DISPLAY_Z) — the real move was even larger. */
  zScoreClamped: boolean;
  /**
   * The uncapped z-score. The "How is this calculated?" panel needs this: it
   * shows the division that produced the sigma, and printing "3.10% / 0.03% =
   * 6.0σ+" is arithmetic that visibly doesn't add up — in the one place whose
   * entire job is showing honest arithmetic.
   */
  zScoreRaw: number | null;
  /** This stock's daily-equivalent volatility, the σ in the z-score. */
  sigmaDaily: number | null;
  /** σ × √(elapsed trading time): how big a move would have been ordinary over this window. */
  expectedMovePct: number | null;
  tier: Tier;
  primaryReason: string;
  secondaryReasons: string[];
  isLevelBreak: boolean;
  isVolumeAnomaly: boolean;
  volumeLevel: VolumeLevel;
  volumeRatio: number | null;
  /** Benchmark index this was judged against, when one was available. */
  benchmarkName: string | null;
  /** The index's move over the same window. */
  benchmarkChangePct: number | null;
  /** The stock's move with the index's move removed — what's specific to this stock. */
  relativeChangePct: number | null;
  /** True when the index explains most of the move: it went with the market, not on its own news. */
  isMarketDriven: boolean;
  volatilityIsLive: boolean;
  dataFreshnessSec: number;
  /** Set by marketFeedStore when a dev shock override is active for this symbol — scoring.ts itself doesn't know about shocks. */
  isSimulated?: boolean;
  newsHeadline?: string;
}

function describeVolume(ratio: number, level: VolumeLevel, sustained: boolean, clamped: boolean): string {
  const amount = `${ratio.toFixed(1)}x${clamped ? "+" : ""}`;
  if (level !== "SURGE") return `Volume is ${amount} this stock's recent pace.`;
  return sustained
    ? `Volume surged to ${amount} this stock's recent pace and is holding there.`
    : `Volume surged to ${amount} this stock's recent pace.`;
}

export function scoreSymbol(params: {
  quote: NSEQuote;
  now?: number;
  lastSeen: LastSeen | null;
  volatility: VolatilityResult;
  volumeAnomaly: VolumeAnomalyResult;
  /** Optional. When absent, scoring behaves exactly as it did before benchmarks existed. */
  benchmark?: BenchmarkContext | null;
}): AttentionCard {
  const { quote, lastSeen, volatility, volumeAnomaly } = params;
  const benchmark = params.benchmark ?? null;
  const now = params.now ?? Date.now();

  // high52w/low52w are null when Yahoo's response omits them — treat that
  // as "we don't know," never as "crossed" (see ERRORS.md: defaulting a
  // missing bound to the current price used to make this trivially true
  // on every poll for any symbol with incomplete 52-week history).
  const brokeHigh = quote.high52w !== null && quote.price >= quote.high52w;
  const brokeLow = quote.low52w !== null && quote.price <= quote.low52w;
  const isLevelBreak = brokeHigh || brokeLow;

  // The tracker already classifies, but the shock-injector path and any
  // hand-built test input may not — classify from the ratio so there is
  // exactly one definition of what "elevated" and "surge" mean.
  const volumeLevel: VolumeLevel = volumeAnomaly.ratio !== null
    ? classifyVolumeRatio(volumeAnomaly.ratio)
    : "NORMAL";
  const dataFreshnessSec = Math.max(0, Math.round((now - quote.sourceTimestamp) / 1000));

  // "Never checked before" is its own state (NEW), not a shot at
  // CRITICAL/NOTABLE. There's no "since you last checked" baseline yet, so
  // there's nothing to diff — a level-break or volume spike is a real fact
  // about the stock, but neither has anything to do with the user's own
  // history, and showing a freshly-added stock as an alarming red CRITICAL
  // on day one directly contradicts what this product is for. See
  // DECISIONS.md. Genuinely true facts (level break, volume) still surface
  // as secondary context, just without driving the tier.
  if (!lastSeen) {
    const priceChangePct = quote.prevClose > 0 ? (quote.price - quote.prevClose) / quote.prevClose : 0;
    const priceChangeAbs = quote.prevClose > 0 ? quote.price - quote.prevClose : 0;
    const secondaryReasons: string[] = [];
    if (isLevelBreak) {
      const level = brokeHigh ? quote.high52w! : quote.low52w!;
      secondaryReasons.push(`Currently at its 52-week ${brokeHigh ? "high" : "low"} (₹${level.toFixed(2)}).`);
    }
    if (volumeLevel !== "NORMAL" && volumeAnomaly.ratio !== null) {
      secondaryReasons.push(
        `Volume is ${volumeAnomaly.ratio.toFixed(1)}x${volumeAnomaly.ratioClamped ? "+" : ""} its recent pace right now.`
      );
    }
    return {
      symbol: quote.symbol,
      currentPrice: quote.price,
      priceChangePct,
      priceChangeAbs,
      lastSeenPrice: null,
      lastSeenAt: null,
      tradingElapsedMs: null,
      sessionsMissed: 0,
      zScore: null,
      zScoreClamped: false,
      zScoreRaw: null,
      sigmaDaily: volatility.sigma,
      expectedMovePct: null,
      tier: "NEW",
      primaryReason: "New to your watchlist — baseline created.",
      secondaryReasons,
      isLevelBreak,
      isVolumeAnomaly: volumeLevel !== "NORMAL",
      volumeLevel,
      volumeRatio: volumeAnomaly.ratio,
      // A never-checked stock has no window to compare an index over.
      benchmarkName: null,
      benchmarkChangePct: null,
      relativeChangePct: null,
      isMarketDriven: false,
      volatilityIsLive: volatility.isLive,
      dataFreshnessSec,
    };
  }

  // Derived from price vs. lastSeen.price rather than trusting
  // quote.changePct: this way it automatically reflects a dev-shock price
  // override (which only rewrites `price`, not `changePct`) instead of
  // silently showing the real, unshocked change next to a simulated price
  // — that inconsistency was a real bug caught in review, see ERRORS.md.
  const priceChangePct = (quote.price - lastSeen.price) / lastSeen.price;
  const priceChangeAbs = quote.price - lastSeen.price;

  // Tier decisions always use the RAW z-score, never the display-clamped
  // one — capping is a display concern only. (A previous version clamped
  // the same variable used for both, which happened to produce the same
  // tier outcomes only because MAX_DISPLAY_Z > Z_CRITICAL; keeping them
  // explicitly separate means that's true by construction, not by luck.)
  //
  // Elapsed time is measured in *trading* time, not wall-clock. The market
  // is open 6h15m a day, so a Friday-evening-to-Monday-morning gap is ~66
  // wall-clock hours and roughly zero trading hours. Charging that gap 2.6
  // trading days of expected drift is what made a genuine 5% weekend gap
  // score 0.57σ → QUIET → "no notable activity since last check" — on
  // exactly the return visit this product is named after. See marketHours.ts.
  const elapsed = tradingElapsedBetween(lastSeen.timestamp, now);
  const effectiveElapsedMs =
    elapsed.tradingMs + elapsed.sessionOpens * OVERNIGHT_GAP_TRADING_FRACTION * TRADING_DAY_MS;
  const elapsedTradingFraction = Math.max(effectiveElapsedMs / TRADING_DAY_MS, MIN_ELAPSED_FRACTION);
  const expectedMoveForElapsed = volatility.sigma * Math.sqrt(elapsedTradingFraction);
  const rawZ = expectedMoveForElapsed > 0 ? Math.abs(priceChangePct) / expectedMoveForElapsed : null;
  let zScore: number | null = rawZ;
  let zScoreClamped = false;
  if (rawZ !== null && rawZ > MAX_DISPLAY_Z) {
    zScore = MAX_DISPLAY_Z;
    zScoreClamped = true;
  }
  const zScoreLabel = (z: number) => `${z.toFixed(1)}σ${zScoreClamped ? "+" : ""}`;

  // How much of this move is the stock, and how much is just the market?
  //
  // The residual is the plain difference (i.e. beta assumed to be 1) rather
  // than a regression-fitted beta. That is deliberate: a fitted beta needs a
  // per-symbol history this app doesn't keep, and would make the number harder
  // to explain on a card. Beta-1 answers the question people actually ask —
  // "did it move more than the market?" — and is honest about being a
  // simplification.
  const benchmarkChangePct = benchmark ? benchmark.changePct : null;
  const relativeChangePct = benchmarkChangePct !== null ? priceChangePct - benchmarkChangePct : null;
  // Only claim a move was market-driven when the index actually moved, the
  // stock moved *with* it rather than against it, and the index explains most
  // of the move rather than a sliver of it.
  const indexMovedMeaningfully =
    benchmarkChangePct !== null && Math.abs(benchmarkChangePct) >= BENCHMARK_MEANINGFUL_MOVE;
  const sameDirection =
    benchmarkChangePct !== null && Math.sign(benchmarkChangePct) === Math.sign(priceChangePct);
  const marketExplainsMost =
    relativeChangePct !== null &&
    Math.abs(priceChangePct) > 0 &&
    Math.abs(relativeChangePct) <= MARKET_DRIVEN_RESIDUAL_FRACTION * Math.abs(priceChangePct);
  const isMarketDriven = indexMovedMeaningfully && sameDirection && marketExplainsMost;

  // A level break the user already acknowledged is not news. Without this,
  // a stock sitting at its 52-week high stays NOTABLE forever no matter how
  // many times "mark all as seen" is clicked, and the "N need your
  // attention" headline never reaches zero — the number stops meaning
  // anything. Same idea for volume, with a margin: it has to go materially
  // beyond what was acknowledged to count again.
  const levelBreakIsNews = isLevelBreak && lastSeen.levelBreak !== true;
  const acknowledgedRatio = lastSeen.volumeRatio ?? null;
  const volumeReflagFloor =
    acknowledgedRatio === null
      ? VOLUME_ELEVATED_RATIO
      : Math.max(VOLUME_ELEVATED_RATIO, acknowledgedRatio * VOLUME_REFLAG_FACTOR);
  const volumeIsNews =
    volumeLevel !== "NORMAL" && volumeAnomaly.ratio !== null && volumeAnomaly.ratio >= volumeReflagFloor;

  const secondaryReasons: string[] = [];
  let tier: Tier = "QUIET";
  let primaryReason = "No notable activity since last check.";
  const defaultReason = primaryReason;
  let signalWeight = 0;

  const addReason = (reason: string) => {
    if (primaryReason === defaultReason) primaryReason = reason;
    else secondaryReasons.push(reason);
  };

  if (rawZ !== null && zScore !== null) {
    if (rawZ >= Z_CRITICAL) {
      tier = maxTier(tier, "CRITICAL");
      primaryReason = `Price moved ${(priceChangePct * 100).toFixed(1)}% — a ${zScoreLabel(zScore)} move, unusual for this stock.`;
      signalWeight += WEIGHT_PRICE;
    } else if (rawZ >= Z_NOTABLE) {
      tier = maxTier(tier, "NOTABLE");
      primaryReason = `Price moved ${(priceChangePct * 100).toFixed(1)}% (${zScoreLabel(zScore)} for this stock).`;
      signalWeight += WEIGHT_PRICE;
    }
  }

  if (levelBreakIsNews) {
    const level = brokeHigh ? quote.high52w! : quote.low52w!;
    tier = maxTier(tier, "NOTABLE");
    addReason(`Crossed its 52-week ${brokeHigh ? "high" : "low"} (₹${level.toFixed(2)}).`);
    signalWeight += WEIGHT_LEVEL_BREAK;
  }

  if (volumeIsNews && volumeAnomaly.ratio !== null) {
    tier = maxTier(tier, "NOTABLE");
    addReason(describeVolume(volumeAnomaly.ratio, volumeLevel, volumeAnomaly.sustained, volumeAnomaly.ratioClamped));
    signalWeight += volumeWeight(volumeLevel, volumeAnomaly.sustained);
  }

  // Escalate one level once enough weight has accumulated. Two independent
  // signals agreeing is more significant than either alone (the original
  // rule, unchanged) — and a volume SURGE now carries that weight by itself,
  // which is how heavy trading can move a symbol QUIET → NOTABLE → CRITICAL
  // without a price signal having to do all the work.
  if (signalWeight >= ESCALATION_WEIGHT) tier = escalate(tier);

  // Step the tier back down when the move was the market, not the stock.
  //
  // This is the point of tracking benchmarks at all. On a broad sell-off every
  // holding drops together and the whole list turns red — technically true,
  // and useless: none of it is news about any individual stock. Demoting one
  // level keeps it visible with an honest explanation instead of shouting.
  //
  // Deliberately only ONE level, and only when the price signal is what drove
  // the tier. A 52-week break or a volume surge is a fact about this stock that
  // the index does not explain away, so those keep their tier.
  const priceDroveTheTier = rawZ !== null && rawZ >= Z_NOTABLE;
  if (isMarketDriven && priceDroveTheTier && signalWeight <= WEIGHT_PRICE) {
    tier = tier === "CRITICAL" ? "NOTABLE" : "QUIET";
    primaryReason =
      tier === "QUIET"
        ? `Moved ${(priceChangePct * 100).toFixed(1)}% with the market — ${benchmark!.name} is ${(benchmarkChangePct! * 100).toFixed(1)}%.`
        : `Price moved ${(priceChangePct * 100).toFixed(1)}%, but ${benchmark!.name} is ${(benchmarkChangePct! * 100).toFixed(1)}% — mostly the market, not the stock.`;
  } else if (benchmark && indexMovedMeaningfully && tier !== "QUIET") {
    // Not market-driven, and the index moved: say so, because "it fell while
    // the market rose" is a stronger signal than the raw percentage alone.
    secondaryReasons.push(
      `${benchmark.name} is ${(benchmarkChangePct! * 100).toFixed(1)}% over the same window — ${
        relativeChangePct! >= 0 ? "+" : ""
      }${(relativeChangePct! * 100).toFixed(1)}% of this is specific to the stock.`
    );
  }

  // A level break the user already knows about is still a true fact about
  // the stock — it just isn't news. Keep it visible as context so the card
  // doesn't silently drop information, without letting it drive the tier.
  if (isLevelBreak && !levelBreakIsNews) {
    const level = brokeHigh ? quote.high52w! : quote.low52w!;
    secondaryReasons.push(`Still at its 52-week ${brokeHigh ? "high" : "low"} (₹${level.toFixed(2)}) — already seen.`);
  }
  if (volumeLevel !== "NORMAL" && !volumeIsNews && volumeAnomaly.ratio !== null) {
    secondaryReasons.push(
      `Volume still ${volumeAnomaly.ratio.toFixed(1)}x${volumeAnomaly.ratioClamped ? "+" : ""} recent pace — already seen.`
    );
  }

  return {
    symbol: quote.symbol,
    currentPrice: quote.price,
    priceChangePct,
    priceChangeAbs,
    lastSeenPrice: lastSeen.price,
    lastSeenAt: lastSeen.timestamp,
    tradingElapsedMs: elapsed.tradingMs,
    sessionsMissed: elapsed.sessionOpens,
    zScore,
    zScoreClamped,
    zScoreRaw: rawZ,
    sigmaDaily: volatility.sigma,
    expectedMovePct: expectedMoveForElapsed > 0 ? expectedMoveForElapsed : null,
    tier,
    primaryReason,
    secondaryReasons,
    isLevelBreak,
    isVolumeAnomaly: volumeLevel !== "NORMAL",
    volumeLevel,
    volumeRatio: volumeAnomaly.ratio,
    benchmarkName: benchmark?.name ?? null,
    benchmarkChangePct,
    relativeChangePct,
    isMarketDriven,
    volatilityIsLive: volatility.isLive,
    dataFreshnessSec,
  };
}
