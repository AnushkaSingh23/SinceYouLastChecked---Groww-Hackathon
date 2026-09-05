// Smoke test for Phase 3 — scoring engine. Pure logic, synthetic inputs,
// no network/dev-server needed. Run with: npm run test:engine
//
// Every case pins an explicit `now` rather than using Date.now(). The engine
// measures elapsed time in *trading* time, so "one hour ago" means something
// different at 2pm on a Tuesday than at 2am on a Sunday — a test that reads
// the wall clock would pass or fail depending on when it happened to run.

import { scoreSymbol } from "../src/lib/scoring";
import type { NSEQuote } from "../src/lib/marketData";
import type { VolumeAnomalyResult } from "../src/lib/volumeAnomaly";

let failures = 0;
function check(name: string, condition: boolean) {
  if (condition) console.log(`PASS: ${name}`);
  else {
    console.error(`FAIL: ${name}`);
    failures++;
  }
}

// Fixed reference points, all real NSE session times (IST = UTC+5:30).
// Fri 2026-09-04 and Mon 2026-09-07 are both ordinary trading days.
const FRI_1400 = Date.parse("2026-09-04T08:30:00Z"); // Fri 2:00 PM IST, mid-session
const FRI_1300 = Date.parse("2026-09-04T07:30:00Z"); // Fri 1:00 PM IST, same session
const FRI_1530 = Date.parse("2026-09-04T10:00:00Z"); // Fri 3:30 PM IST, the close
const THU_1800 = Date.parse("2026-09-03T12:30:00Z"); // Thu 6:00 PM IST, after close
const FRI_0930 = Date.parse("2026-09-04T04:00:00Z"); // Fri 9:30 AM IST, just after the open
const MON_0930 = Date.parse("2026-09-07T04:00:00Z"); // Mon 9:30 AM IST, just after the open

function makeQuote(overrides: Partial<NSEQuote> = {}): NSEQuote {
  return {
    symbol: "TEST.NS",
    price: 102,
    changePct: 2,
    volume: 1_000_000,
    high52w: 150,
    low52w: 80,
    prevClose: 100,
    sourceTimestamp: FRI_1400,
    ...overrides,
  };
}

/** A volume reading. `sustained` mirrors the tracker's "this surge held for consecutive polls" flag. */
function volume(ratio: number | null, sustained = true): VolumeAnomalyResult {
  return {
    isAnomaly: ratio !== null && ratio >= 1.5,
    level: ratio === null ? "NORMAL" : ratio >= 3 ? "SURGE" : ratio >= 1.5 ? "ELEVATED" : "NORMAL",
    ratio,
    sustained: sustained && ratio !== null && ratio >= 3,
    ratioClamped: false,
    isLive: true,
  };
}
const NO_VOLUME_SIGNAL = volume(null);

// Test 1: same raw % move, different volatility tiers -> different tiers.
// This is the product's central claim, so it asserts the *tiers*, not just
// that one z-score exceeds the other (which is arithmetically guaranteed
// whenever sigma_low < sigma_high and so proved almost nothing).
const move2pct = makeQuote({ price: 102, prevClose: 100 });
const lowVolResult = scoreSymbol({
  quote: move2pct,
  now: FRI_1400,
  lastSeen: { price: 100, timestamp: FRI_1300 },
  volatility: { sigma: 0.008, isLive: true }, // low-vol blue chip, e.g. HDFCBANK-tier
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
const highVolResult = scoreSymbol({
  quote: move2pct,
  now: FRI_1400,
  lastSeen: { price: 100, timestamp: FRI_1300 },
  volatility: { sigma: 0.038, isLive: true }, // high-vol name, e.g. ADANIENT-tier
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check(
  `same 2% move is CRITICAL on the low-vol stock and not on the high-vol one (low=${lowVolResult.tier}, high=${highVolResult.tier})`,
  lowVolResult.tier === "CRITICAL" && highVolResult.tier !== "CRITICAL"
);
check(
  `and the z-scores order the same way (low=${lowVolResult.zScore?.toFixed(2)}, high=${highVolResult.zScore?.toFixed(2)})`,
  (lowVolResult.zScore ?? 0) > (highVolResult.zScore ?? 0)
);

// Test 2: volume alone drives the tier, and does so proportionally.
// An ELEVATED ratio is worth NOTABLE; a SURGE carries enough weight on its
// own to reach CRITICAL without any price signal at all.
const flatPriceQuote = makeQuote({ price: 100.05, prevClose: 100 });
const scoreVolumeOnly = (ratio: number) =>
  scoreSymbol({
    quote: flatPriceQuote,
    now: FRI_1400,
    lastSeen: { price: 100, timestamp: FRI_1300 },
    volatility: { sigma: 0.02, isLive: true },
    volumeAnomaly: volume(ratio),
  });

const volNormal = scoreVolumeOnly(1.2);
const volElevated = scoreVolumeOnly(2.0);
const volSurge = scoreVolumeOnly(4.2);

check(`volume below 1.5x on a flat price stays QUIET (got ${volNormal.tier})`, volNormal.tier === "QUIET");
check(`volume at 2.0x on a flat price is NOTABLE (got ${volElevated.tier})`, volElevated.tier === "NOTABLE");
check(`volume at 4.2x on a flat price escalates all the way to CRITICAL (got ${volSurge.tier})`, volSurge.tier === "CRITICAL");
check("volume anomaly reason surfaces in primary or secondary", volSurge.primaryReason.includes("Volume"));
check("a surge is described as a surge, not just a multiple", volSurge.primaryReason.includes("surged"));

// Test 2a: a surge that has only printed once is NOT yet worth CRITICAL.
// NSE volume is U-shaped, so a single 20-second print at 3x+ is routine into
// the close; without the confirmation requirement the whole list turns red
// every afternoon (observed live against the real feed).
const unconfirmedSurge = scoreSymbol({
  quote: flatPriceQuote,
  now: FRI_1400,
  lastSeen: { price: 100, timestamp: FRI_1300 },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: volume(4.2, false),
});
check(
  `a 4.2x surge on its first poll is NOTABLE, not CRITICAL (got ${unconfirmedSurge.tier})`,
  unconfirmedSurge.tier === "NOTABLE"
);
check(
  "...and only the confirmed one reaches CRITICAL",
  volSurge.tier === "CRITICAL" && volSurge.primaryReason.includes("holding")
);

// Test 2b: rising volume escalates monotonically — more volume is never a
// weaker signal than less.
const tierRank = { QUIET: 0, NEW: 0, NOTABLE: 1, CRITICAL: 2 };
check(
  "tier is monotonic in volume ratio (1.2x -> 2.0x -> 4.2x never goes backwards)",
  tierRank[volNormal.tier] <= tierRank[volElevated.tier] && tierRank[volElevated.tier] <= tierRank[volSurge.tier]
);

// Test 2c: volume corroborating a price move still escalates, exactly as two
// independent signals always did — the added weight must not have weakened
// any combination that used to escalate.
const priceAndVolume = scoreSymbol({
  quote: makeQuote({ price: 101.4, prevClose: 100 }),
  now: FRI_1400,
  lastSeen: { price: 100, timestamp: FRI_1300 },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: volume(1.8),
});
check(
  `a NOTABLE price move plus merely elevated volume still escalates to CRITICAL (got ${priceAndVolume.tier})`,
  priceAndVolume.tier === "CRITICAL"
);

// Test 2d: market-relative context. The same -3.1% means opposite things
// depending on whether the whole market moved with it, and this is the single
// biggest source of false urgency in an attention product: on a broad sell-off
// every card turns red and none of it is news about any one stock.
const drop31 = makeQuote({ price: 96.9, prevClose: 100 });
const scoreVsMarket = (indexPct: number | null) =>
  scoreSymbol({
    quote: drop31,
    now: FRI_1400,
    lastSeen: { price: 100, timestamp: FRI_1300 },
    volatility: { sigma: 0.02, isLive: true },
    volumeAnomaly: NO_VOLUME_SIGNAL,
    benchmark: indexPct === null ? null : { symbol: "^NSEI", name: "NIFTY 50", changePct: indexPct },
  });

const noBenchmark = scoreVsMarket(null);
const stockSpecific = scoreVsMarket(-0.002); // market flat, stock -3.1%
const marketWide = scoreVsMarket(-0.029); //    market -2.9%, stock -3.1%

check(
  `with no benchmark the tier is unchanged from before benchmarks existed (got ${noBenchmark.tier})`,
  noBenchmark.tier === "CRITICAL" && noBenchmark.benchmarkName === null
);
check(
  `-3.1% while NIFTY is -0.2% stays CRITICAL — that is the stock (got ${stockSpecific.tier})`,
  stockSpecific.tier === "CRITICAL" && stockSpecific.isMarketDriven === false
);
check(
  `-3.1% while NIFTY is -2.9% is demoted — that is the market (got ${marketWide.tier})`,
  marketWide.tier === "NOTABLE" && marketWide.isMarketDriven === true
);
check(
  "the demoted card explains itself in terms of the market",
  marketWide.primaryReason.includes("NIFTY 50") && marketWide.primaryReason.includes("market")
);
check(
  `the residual is reported, not just the raw move (got ${(marketWide.relativeChangePct! * 100).toFixed(2)}%)`,
  Math.abs(marketWide.relativeChangePct! - -0.002) < 1e-9
);

// "How much of this was the market?" must not depend on how long you were
// away. Judging the residual by z-score made it timescale-dependent: over a
// 20-second window a 0.2% divergence is already >5 sigma, so a market-wide
// drop would never be recognised on a short visit — which is exactly the case
// a live demo hits. Same decomposition, same answer, any elapsed time.
const marketWideSeconds = scoreSymbol({
  quote: drop31,
  now: FRI_1400,
  lastSeen: { price: 100, timestamp: FRI_1400 - 20_000 },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: NO_VOLUME_SIGNAL,
  benchmark: { symbol: "^NSEI", name: "NIFTY 50", changePct: -0.029 },
});
check(
  `a market-wide drop is recognised 20 seconds after mark-seen too (got ${marketWideSeconds.tier})`,
  marketWideSeconds.isMarketDriven === true && marketWideSeconds.tier === "NOTABLE"
);

// A stock falling while the market RISES is not market-driven — it is the
// opposite, and must never be softened.
const fellAgainstARisingMarket = scoreVsMarket(0.025);
check(
  `falling 3.1% while the market rose 2.5% is never demoted (got ${fellAgainstARisingMarket.tier})`,
  fellAgainstARisingMarket.tier === "CRITICAL" && fellAgainstARisingMarket.isMarketDriven === false
);

// A barely-moving index explains nothing, so it must not soften anything.
const flatIndex = scoreVsMarket(-0.0005);
check(
  `an index that barely moved never marks a move as market-driven (got ${flatIndex.tier})`,
  flatIndex.tier === "CRITICAL" && flatIndex.isMarketDriven === false
);

// A 52-week break or volume surge is a fact about THIS stock that the index
// does not explain away, so a corroborated move keeps its tier.
const marketWidePlusVolume = scoreSymbol({
  quote: drop31,
  now: FRI_1400,
  lastSeen: { price: 100, timestamp: FRI_1300 },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: volume(4.2),
  benchmark: { symbol: "^NSEI", name: "NIFTY 50", changePct: -0.029 },
});
check(
  `a market-wide drop WITH a confirmed volume surge is not softened (got ${marketWidePlusVolume.tier})`,
  marketWidePlusVolume.tier === "CRITICAL"
);

// Test 3: level break triggers regardless of small price move.
const levelBreakQuote = makeQuote({ price: 150.5, high52w: 150, prevClose: 150.2 });
const levelBreakResult = scoreSymbol({
  quote: levelBreakQuote,
  now: FRI_1400,
  lastSeen: { price: 150.2, timestamp: FRI_1300 },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check(`52-week high break flags isLevelBreak`, levelBreakResult.isLevelBreak === true);
check(`52-week high break escalates tier (got ${levelBreakResult.tier})`, levelBreakResult.tier !== "QUIET");

// Test 3b: a level break the user already acknowledged is no longer news.
// Without this, a stock sitting at its 52-week high stays flagged forever
// however many times "mark all as seen" is clicked, and the "N need your
// attention" headline can never reach zero.
const acknowledgedLevelBreak = scoreSymbol({
  quote: levelBreakQuote,
  now: FRI_1400,
  lastSeen: { price: 150.2, timestamp: FRI_1300, levelBreak: true },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check(
  `an already-acknowledged 52-week high does not re-flag (got ${acknowledgedLevelBreak.tier})`,
  acknowledgedLevelBreak.tier === "QUIET"
);
check(
  "but the fact is still shown as context rather than silently dropped",
  acknowledgedLevelBreak.isLevelBreak === true &&
    acknowledgedLevelBreak.secondaryReasons.some((r) => r.includes("already seen"))
);

// Test 3c: same rule for volume, with a margin — an acknowledged surge stops
// flagging, but a materially bigger one starts again.
const surgeQuote = makeQuote({ price: 100.05, prevClose: 100 });
const acknowledgedSurge = scoreSymbol({
  quote: surgeQuote,
  now: FRI_1400,
  lastSeen: { price: 100, timestamp: FRI_1300, volumeRatio: 4.2 },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: volume(4.2),
});
check(`an already-acknowledged volume surge does not re-flag (got ${acknowledgedSurge.tier})`, acknowledgedSurge.tier === "QUIET");

const escalatingSurge = scoreSymbol({
  quote: surgeQuote,
  now: FRI_1400,
  lastSeen: { price: 100, timestamp: FRI_1300, volumeRatio: 4.2 },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: volume(7.0),
});
check(
  `volume climbing well past what was acknowledged flags again (got ${escalatingSurge.tier})`,
  escalatingSurge.tier === "CRITICAL"
);

// Test 4: elapsed time is TRADING time, not wall-clock. This is the case the
// product is named after and the one the old wall-clock model got wrong: a
// real 5% gap across a weekend scored 0.57σ -> QUIET -> "no notable activity
// since last check."
const gap5pct = makeQuote({ price: 105, prevClose: 100, sourceTimestamp: MON_0930 });
const BAJFINANCE_SIGMA = 0.027;

const weekendGap = scoreSymbol({
  quote: gap5pct,
  now: MON_0930,
  lastSeen: { price: 100, timestamp: FRI_1530 }, // checked at Friday's close
  volatility: { sigma: BAJFINANCE_SIGMA, isLive: true },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check(
  `a real 5% gap over a weekend is CRITICAL, not QUIET (got ${weekendGap.tier} at ${weekendGap.zScore?.toFixed(2)}σ)`,
  weekendGap.tier === "CRITICAL"
);
check(
  `the weekend contributes ~zero trading minutes (got ${Math.round(weekendGap.tradingElapsedMs! / 60000)} min)`,
  weekendGap.tradingElapsedMs! < 20 * 60 * 1000
);
check(`and the card reports the market open that was missed (got ${weekendGap.sessionsMissed})`, weekendGap.sessionsMissed === 1);

// One night, not a night plus a full session: Thursday evening to Friday
// morning. (Thursday evening to *Monday* morning contains an entire extra
// Friday session, so 5% over that span is genuinely NOTABLE rather than
// CRITICAL — a distinction the old wall-clock model could not make at all.)
const overnightGap = scoreSymbol({
  quote: makeQuote({ price: 105, prevClose: 100, sourceTimestamp: FRI_0930 }),
  now: FRI_0930,
  lastSeen: { price: 100, timestamp: THU_1800 }, // checked Thursday evening
  volatility: { sigma: BAJFINANCE_SIGMA, isLive: true },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check(
  `a real 5% overnight gap is CRITICAL, not QUIET (got ${overnightGap.tier} at ${overnightGap.zScore?.toFixed(2)}σ)`,
  overnightGap.tier === "CRITICAL"
);

// The counterpart: the same 5% spread over an extra full trading session is
// less surprising, and the engine should say so rather than flattening both
// into one answer.
const gapPlusFullSession = scoreSymbol({
  quote: makeQuote({ price: 105, prevClose: 100, sourceTimestamp: MON_0930 }),
  now: MON_0930,
  lastSeen: { price: 100, timestamp: THU_1800 },
  volatility: { sigma: BAJFINANCE_SIGMA, isLive: true },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check(
  `the same 5% across an extra full session is ranked below the overnight gap (${gapPlusFullSession.zScore?.toFixed(2)}σ vs ${overnightGap.zScore?.toFixed(2)}σ)`,
  (gapPlusFullSession.zScore ?? 0) < (overnightGap.zScore ?? 0) && gapPlusFullSession.tier !== "QUIET"
);

// ...and the original monotonicity property still holds within a session.
const shortElapsed = scoreSymbol({
  quote: makeQuote({ price: 105, prevClose: 100 }),
  now: FRI_1400,
  lastSeen: { price: 100, timestamp: FRI_1400 - 5 * 60 * 1000 },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
const longElapsed = scoreSymbol({
  quote: makeQuote({ price: 105, prevClose: 100 }),
  now: FRI_1400,
  lastSeen: { price: 100, timestamp: FRI_1400 - 3 * 24 * 60 * 60 * 1000 },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check(
  `same 5% move still scores higher after 5 minutes (${shortElapsed.zScore?.toFixed(2)}) than after 3 days (${longElapsed.zScore?.toFixed(2)})`,
  (shortElapsed.zScore ?? 0) > (longElapsed.zScore ?? 0)
);

// Test 4b: an ordinary opening tick after an overnight gap must NOT be
// alarming. This is the guard on the fix itself — charging a closed session
// zero variance would make ~1 minute of elapsed trading time the denominator
// and turn every normal 0.4% opening move into a double-digit sigma event.
const ordinaryOpen = scoreSymbol({
  quote: makeQuote({ price: 100.4, prevClose: 100, sourceTimestamp: MON_0930 }),
  now: MON_0930,
  lastSeen: { price: 100, timestamp: FRI_1530 },
  volatility: { sigma: BAJFINANCE_SIGMA, isLive: true },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check(
  `an ordinary 0.4% move across a weekend stays QUIET (got ${ordinaryOpen.tier} at ${ordinaryOpen.zScore?.toFixed(2)}σ)`,
  ordinaryOpen.tier === "QUIET"
);

// Test 5: a symbol with NO last-seen snapshot (just added to the
// watchlist) must never explode into a huge z-score/CRITICAL tier — this
// regressed for real: an early build showed a freshly-added stock as a
// 36.9-sigma CRITICAL move because of a bad elapsed-time guess. See ERRORS.md.
const freshAddQuote = makeQuote({ price: 1330.3, prevClose: 1302.5, changePct: 2.13, high52w: 1600, low52w: 1100 });
const freshAddResult = scoreSymbol({
  quote: freshAddQuote,
  now: FRI_1400,
  lastSeen: null,
  volatility: { sigma: 0.016, isLive: false },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check(`never-seen-before symbol has no z-score (got ${freshAddResult.zScore})`, freshAddResult.zScore === null);
check(`never-seen-before symbol is NEW, not CRITICAL (got ${freshAddResult.tier})`, freshAddResult.tier === "NEW");
check(`NEW tier has the baseline-created message`, freshAddResult.primaryReason === "New to your watchlist — baseline created.");

// Test 5b: NEW must hold even when a never-seen symbol has BOTH a real
// level-break AND a real volume anomaly at the same time — this is the
// exact scenario a judge could hit: add a stock that happens to be at its
// 52-week high with unusual volume right now, and the two real, independent
// signals used to combine via the same escalation rule that applies once
// there's a baseline, producing a false CRITICAL on a stock with zero
// "since you checked" history. NEW must never escalate.
const activeNewStockQuote = makeQuote({ price: 150, prevClose: 148, high52w: 150, low52w: 80 });
const activeNewStockResult = scoreSymbol({
  quote: activeNewStockQuote,
  now: FRI_1400,
  lastSeen: null,
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: volume(5.0),
});
check(
  `a never-seen stock at its 52-week high WITH a volume spike is still NEW, not escalated (got ${activeNewStockResult.tier})`,
  activeNewStockResult.tier === "NEW"
);
check(
  "the real level-break and volume facts still surface as context, just not as an alarming tier",
  activeNewStockResult.secondaryReasons.length === 2
);

// Test 6: a real move over a near-instant elapsed time (e.g. the dev shock
// injector fired seconds after "mark as seen") must never display an
// absurd z-score. This is a real bug that shipped: a -6.2% shock 1 second
// after mark-seen displayed as "89.8σ" / "130.5σ" — technically what the
// sqrt(time) math produces, but reads as broken to anyone looking at it.
// See ERRORS.md.
const nearInstantQuote = makeQuote({ price: 993.06, prevClose: 1059 });
const nearInstantResult = scoreSymbol({
  quote: nearInstantQuote,
  now: FRI_1400,
  lastSeen: { price: 1059, timestamp: FRI_1400 - 1000 },
  volatility: { sigma: BAJFINANCE_SIGMA, isLive: true },
  volumeAnomaly: volume(4.1),
});
check(
  `a large move 1 second after mark-seen never displays an absurd z-score (got ${nearInstantResult.zScore})`,
  (nearInstantResult.zScore ?? 0) <= 6
);
check("that z-score is flagged as clamped, not silently truncated", nearInstantResult.zScoreClamped === true);
check(
  `the reason string shows the clamp honestly, not a fake precise huge number`,
  nearInstantResult.primaryReason.includes("6.0σ+")
);

// Test 7: a shocked "never seen before" card must show a price change that
// actually matches the shocked price, not the real day's unshocked change.
// This is a real bug caught in review: the shock overlay only rewrote
// `price`, so a card could show a shocked (e.g. -6%) currentPrice right
// next to a green "+1.9%" badge computed from the real, untouched day
// change — exactly the "reads as broken" failure mode. Fixed by deriving
// priceChangePct from price vs. prevClose consistently in both branches,
// so an overridden price is automatically reflected. See ERRORS.md.
const shockedNeverSeenQuote = makeQuote({ price: 1220, prevClose: 1300, changePct: 1.9, high52w: 1600, low52w: 1100 });
const shockedNeverSeenResult = scoreSymbol({
  quote: shockedNeverSeenQuote,
  now: FRI_1400,
  lastSeen: null,
  volatility: { sigma: 0.016, isLive: false },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check(
  `shocked never-seen card's priceChangePct reflects the shocked price, not the stale real changePct (got ${(shockedNeverSeenResult.priceChangePct * 100).toFixed(2)}%)`,
  shockedNeverSeenResult.priceChangePct < 0
);

// Test 8: a symbol with missing 52-week bounds (Yahoo omits the field) must
// never be treated as having crossed a level it doesn't actually know.
// Previously high52w/low52w defaulted to the current price, which made
// `price >= high52w` trivially true every single poll. See ERRORS.md.
const missingBoundsQuote = makeQuote({ price: 500, prevClose: 495, high52w: null, low52w: null });
const missingBoundsResult = scoreSymbol({
  quote: missingBoundsQuote,
  now: FRI_1400,
  lastSeen: { price: 495, timestamp: FRI_1300 },
  volatility: { sigma: 0.02, isLive: true },
  volumeAnomaly: NO_VOLUME_SIGNAL,
});
check("missing 52-week bounds never register as a level break", missingBoundsResult.isLevelBreak === false);

// Test 9: the card carries the baseline it diffed against, so the UI can
// actually render "₹1,240 → ₹1,310" instead of leaving the "from" implicit.
check(
  `the card reports the last-seen price it diffed against (got ${weekendGap.lastSeenPrice})`,
  weekendGap.lastSeenPrice === 100 && weekendGap.lastSeenAt === FRI_1530
);

console.log(failures === 0 ? "\nAll phase 3 smoke checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
