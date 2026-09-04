// Smoke test for the two pure modules that previously had no coverage at
// all, and which the tiering now leans on directly:
//   - marketHours.tradingElapsedBetween — the denominator behind every
//     z-score, and the fix for overnight/weekend gaps scoring as QUIET.
//   - volumeAnomaly — now weighted heavily enough to carry a symbol to
//     CRITICAL on its own, so its false-positive modes matter more.
//
// Pure logic, no network, no dev server. Run with: npm run test:signals

import { tradingElapsedBetween, getNSEMarketStatus, TRADING_DAY_MS } from "../src/lib/marketHours";
import { VolumeAnomalyTracker, classifyVolumeRatio } from "../src/lib/volumeAnomaly";

let failures = 0;
function check(name: string, condition: boolean) {
  if (condition) console.log(`PASS: ${name}`);
  else {
    console.error(`FAIL: ${name}`);
    failures++;
  }
}

const MIN = 60 * 1000;
const at = (iso: string) => Date.parse(iso);

// IST = UTC+5:30. 2026-09-04 is a Friday, 2026-09-07 a Monday, and
// 2026-09-14 is Ganesh Chaturthi — the one NSE holiday in the app's calendar.

// --- marketHours: trading time ---------------------------------------------

const withinSession = tradingElapsedBetween(at("2026-09-04T07:30:00Z"), at("2026-09-04T08:30:00Z"));
check(
  `one hour inside a session counts as one hour (got ${withinSession.tradingMs / MIN} min)`,
  withinSession.tradingMs === 60 * MIN && withinSession.sessionOpens === 0
);

const overnight = tradingElapsedBetween(at("2026-09-03T12:30:00Z"), at("2026-09-04T04:00:00Z")); // Thu 6pm -> Fri 9:30am
check(
  `an overnight gap counts only the 15 minutes of Friday trading (got ${overnight.tradingMs / MIN} min)`,
  overnight.tradingMs === 15 * MIN
);
check("...and reports the one market open that was missed", overnight.sessionOpens === 1);

const weekend = tradingElapsedBetween(at("2026-09-04T10:00:00Z"), at("2026-09-07T04:00:00Z")); // Fri close -> Mon 9:30am
check(
  `a whole weekend contributes only Monday's 15 minutes, not 66 hours (got ${weekend.tradingMs / MIN} min)`,
  weekend.tradingMs === 15 * MIN
);
check("...and is still a single missed open, not three", weekend.sessionOpens === 1);

const acrossHoliday = tradingElapsedBetween(at("2026-09-11T10:00:00Z"), at("2026-09-15T04:00:00Z"));
check(
  `Fri close -> Tue 9:30am across the Monday holiday skips the holiday entirely (got ${acrossHoliday.tradingMs / MIN} min)`,
  acrossHoliday.tradingMs === 15 * MIN && acrossHoliday.sessionOpens === 1
);

const twoFullDays = tradingElapsedBetween(at("2026-09-03T03:45:00Z"), at("2026-09-04T10:00:00Z")); // Thu open -> Fri close
check(
  `two full sessions measure as two trading days (got ${(twoFullDays.tradingMs / TRADING_DAY_MS).toFixed(2)})`,
  Math.abs(twoFullDays.tradingMs - 2 * TRADING_DAY_MS) < 1000 && twoFullDays.sessionOpens === 1
);

const closedOnly = tradingElapsedBetween(at("2026-09-05T06:00:00Z"), at("2026-09-06T06:00:00Z")); // all weekend
check("a span entirely inside a weekend has zero trading time and no opens", closedOnly.tradingMs === 0 && closedOnly.sessionOpens === 0);

check("a reversed range returns zero rather than a negative", tradingElapsedBetween(at("2026-09-04T10:00:00Z"), at("2026-09-04T04:00:00Z")).tradingMs === 0);
check("an absurdly old timestamp is approximated, not looped over forever", tradingElapsedBetween(0, at("2026-09-04T10:00:00Z")).tradingMs > 0);

// --- marketHours: session boundaries ---------------------------------------

const statusAt = (iso: string) => getNSEMarketStatus(new Date(at(iso)));
check("09:14 IST is still pre-market", statusAt("2026-09-04T03:44:00Z").isOpen === false);
check("09:15 IST is open", statusAt("2026-09-04T03:45:00Z").isOpen === true);
check("15:29 IST is still open", statusAt("2026-09-04T09:59:00Z").isOpen === true);
check("15:30 IST is closed", statusAt("2026-09-04T10:00:00Z").isOpen === false);
check("Saturday mid-session hours are a weekend, not a session", statusAt("2026-09-05T06:00:00Z").reason === "WEEKEND");
check("the known NSE holiday is reported as a holiday", statusAt("2026-09-14T06:00:00Z").reason === "HOLIDAY");
check(
  `Friday evening names Monday rather than "next trading day" (got "${statusAt("2026-09-04T13:00:00Z").nextSessionText}")`,
  statusAt("2026-09-04T13:00:00Z").nextSessionText.includes("Monday")
);
check(
  `the evening before the holiday skips it (got "${statusAt("2026-09-13T13:00:00Z").nextSessionText}")`,
  statusAt("2026-09-13T13:00:00Z").nextSessionText.includes("Tuesday")
);

// --- volumeAnomaly ---------------------------------------------------------

check("1.2x is normal", classifyVolumeRatio(1.2) === "NORMAL");
check("1.5x is the elevated boundary", classifyVolumeRatio(1.5) === "ELEVATED");
check("3.0x is the surge boundary", classifyVolumeRatio(3) === "SURGE");
check("a null ratio is normal, never an anomaly", classifyVolumeRatio(null) === "NORMAL");

/** Feed a tracker a run of equal per-poll deltas, then one final delta. */
function feed(steady: number, steadyCount: number, ...finals: number[]) {
  const t = new VolumeAnomalyTracker("TEST.NS");
  let cumulative = 0;
  t.addReading(cumulative);
  for (let i = 0; i < steadyCount; i++) t.addReading((cumulative += steady));
  let last = t.getLastResult();
  for (const f of finals) last = t.addReading((cumulative += f));
  return last;
}

const warming = feed(1000, 4, 1000);
check("under the minimum sample count the tracker says so rather than guessing", warming.isLive === false);

const steady = feed(1000, 12, 1000);
check(`a steady pace is not an anomaly (ratio ${steady.ratio?.toFixed(2)})`, steady.isLive === true && steady.level === "NORMAL");

const doubled = feed(1000, 12, 2000);
check(`a doubling is ELEVATED (ratio ${doubled.ratio?.toFixed(2)})`, doubled.level === "ELEVATED");

const quadrupled = feed(1000, 12, 4000);
check(`a 4x print is a SURGE (ratio ${quadrupled.ratio?.toFixed(2)})`, quadrupled.level === "SURGE");
check("...but a single 4x print is not yet a confirmed one", quadrupled.sustained === false);
check("a second consecutive 4x print confirms it", feed(1000, 12, 4000, 4000).sustained === true);
check("one normal print in between resets the confirmation", feed(1000, 12, 4000, 1000, 4000).sustained === false);

// The bug this replaced a mean with a median for: with a mean baseline, a
// sustained surge drags its own denominator up and normalises away within a
// few polls, so a genuine multi-minute surge stops registering while it is
// still happening.
const sustained = feed(1000, 12, 4000, 4000, 4000, 4000, 4000);
check(
  `a sustained surge is still a surge five polls in (ratio ${sustained.ratio?.toFixed(2)}, level ${sustained.level})`,
  sustained.level === "SURGE" && sustained.sustained === true
);

// The other one: zero deltas are the absence of a pace measurement, not a
// measurement of zero pace. Letting them into the baseline made the first
// real print after a quiet stretch read as a huge anomaly.
const afterQuietStretch = feed(1000, 12, 0, 0, 0, 0, 0, 0, 0, 0, 1000);
check(
  `a normal print after a run of no-trade polls is not an anomaly (ratio ${afterQuietStretch.ratio?.toFixed(2)})`,
  afterQuietStretch.level === "NORMAL"
);

// Session rollover: cumulative volume resets to a smaller number.
const t = new VolumeAnomalyTracker("TEST.NS");
let cum = 0;
t.addReading(cum);
for (let i = 0; i < 12; i++) t.addReading((cum += 1000));
const afterReset = t.addReading(500); // new session, cumulative restarts
check("a session rollover clears the baseline instead of reading as a huge negative", afterReset.isLive === false && afterReset.ratio === null);

const enormous = feed(1000, 12, 500_000);
check(`an enormous ratio is clamped for display and flagged as clamped (got ${enormous.ratio})`, enormous.ratio === 10 && enormous.ratioClamped === true);
check("...but is still classified from the raw value, so it stays a SURGE", enormous.level === "SURGE");

console.log(failures === 0 ? "\nAll phase 7 smoke checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
