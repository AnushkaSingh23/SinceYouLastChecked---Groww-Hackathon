// Knows two things about NSE (India):
//   1. whether the market is open *right now*, so the app can show an honest
//      "market closed" state instead of a generic staleness timer, and
//   2. how much actual *trading* time separates two instants.
//
// (2) is what makes "since you last checked" honest across nights, weekends
// and holidays. Wall-clock elapsed time is the wrong denominator for "how
// surprising is this move?" — the market is only open 6h15m a day, so a
// Friday-evening-to-Monday-morning gap is ~66 wall-clock hours but roughly
// *zero* trading hours. Billing that gap as ~2.6 trading days of expected
// drift is what made a genuine 5% weekend gap score 0.57 sigma — "no notable
// activity" — on exactly the return visit this product is named after.
// See scoring.ts for how the result is used.
//
// IST is a fixed UTC+5:30 offset with no daylight saving, so all the calendar
// arithmetic below is plain math on epoch milliseconds rather than repeated
// Intl formatting (which the old implementation did on every call, and which
// can't express "how many session-opens fell between these two instants"
// without a loop anyway). Intl is still used for the one thing arithmetic
// can't do: naming the next trading day for a human.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const MARKET_OPEN_MS = (9 * 60 + 15) * 60 * 1000; // 9:15 AM IST
const MARKET_CLOSE_MS = (15 * 60 + 30) * 60 * 1000; // 3:30 PM IST

/**
 * Length of one NSE session, 9:15am-3:30pm IST = 6h15m. This is the unit
 * volatility is expressed in (see volatility.ts) and the unit elapsed time
 * is measured in (see scoring.ts) — one canonical definition, not two.
 */
export const TRADING_DAY_MS = MARKET_CLOSE_MS - MARKET_OPEN_MS;

// Known NSE trading holidays. Deliberately not a fabricated full-year
// calendar — only dates actually verified against NSE's published list are
// here, because a wrong holiday is worse than a missing one (it would make
// the app claim "closed" on a real trading day). Extend as needed; a symbol
// simply not trading on an unlisted holiday shows up as stale data, which
// the freshness indicator already reports honestly.
const NSE_HOLIDAYS = new Set([
  "2026-09-14", // Ganesh Chaturthi
]);

/** Epoch-ms -> the IST calendar day it falls on, as a day index (days since 1970-01-01 IST). */
function istDayIndex(epochMs: number): number {
  return Math.floor((epochMs + IST_OFFSET_MS) / DAY_MS);
}

/** Epoch ms of IST midnight starting the given day index. */
function dayStartEpoch(dayIndex: number): number {
  return dayIndex * DAY_MS - IST_OFFSET_MS;
}

/** "YYYY-MM-DD" for a day index — dayIndex * DAY_MS is exactly UTC midnight of that calendar date. */
function dateKey(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday. Epoch day 0 (1970-01-01) was a Thursday. */
function weekdayOf(dayIndex: number): number {
  return (((dayIndex + 4) % 7) + 7) % 7;
}

function isTradingDay(dayIndex: number): boolean {
  const wd = weekdayOf(dayIndex);
  if (wd === 0 || wd === 6) return false;
  return !NSE_HOLIDAYS.has(dateKey(dayIndex));
}

export interface TradingElapsed {
  /** Milliseconds of actual open-market time between the two instants. */
  tradingMs: number;
  /**
   * How many session opens fell inside the window — i.e. how many overnight
   * or weekend gaps the user slept through. Each one carries real variance
   * even though it contains zero trading minutes (prices reopen on news that
   * broke while the market was shut), so scoring.ts charges each a fixed
   * fraction of a trading day rather than nothing.
   */
  sessionOpens: number;
}

// A corrupted or absurd timestamp shouldn't turn into a multi-million
// iteration loop on a request path. Past this horizon the exact answer stops
// mattering — anything that old is "ancient" for a since-you-last-checked
// diff — so fall back to the 5-trading-days-in-7 approximation.
const MAX_DAYS_WALKED = 400;

/**
 * Open-market time between two instants, plus the number of session opens in
 * between. Both bounds are epoch ms. Returns zeros when `endMs <= startMs`.
 */
export function tradingElapsedBetween(startMs: number, endMs: number): TradingElapsed {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { tradingMs: 0, sessionOpens: 0 };
  }

  const firstDay = istDayIndex(startMs);
  const lastDay = istDayIndex(endMs);

  if (lastDay - firstDay > MAX_DAYS_WALKED) {
    const tradingDays = (lastDay - firstDay) * (5 / 7);
    return { tradingMs: tradingDays * TRADING_DAY_MS, sessionOpens: Math.round(tradingDays) };
  }

  let tradingMs = 0;
  let sessionOpens = 0;

  for (let d = firstDay; d <= lastDay; d++) {
    if (!isTradingDay(d)) continue;

    const dayStart = dayStartEpoch(d);
    const open = dayStart + MARKET_OPEN_MS;
    const close = dayStart + MARKET_CLOSE_MS;

    const overlapStart = Math.max(startMs, open);
    const overlapEnd = Math.min(endMs, close);
    if (overlapEnd > overlapStart) tradingMs += overlapEnd - overlapStart;

    // Strictly after the start: a snapshot taken exactly at the open hasn't
    // "missed" that open. Inclusive of the end so a check made at 9:15 on
    // the dot does count the gap it just came through.
    if (open > startMs && open <= endMs) sessionOpens++;
  }

  return { tradingMs, sessionOpens };
}

/** Epoch ms of the next session open strictly after `nowMs`. */
function nextOpenAfter(nowMs: number): number {
  const start = istDayIndex(nowMs);
  for (let d = start; d <= start + 30; d++) {
    if (!isTradingDay(d)) continue;
    const open = dayStartEpoch(d) + MARKET_OPEN_MS;
    if (open > nowMs) return open;
  }
  // Unreachable in practice — NSE never closes for a month. Falling back to
  // "tomorrow" beats returning something nonsensical.
  return dayStartEpoch(start + 1) + MARKET_OPEN_MS;
}

/**
 * Names the next session in the way a person would. The old version was a
 * hardcoded "Opens next trading day at 9:15 AM IST" that didn't skip weekends
 * or holidays — vague on a Friday evening, where it could just say "Monday".
 */
function describeNextOpen(nowMs: number): string {
  const open = nextOpenAfter(nowMs);
  const todayIdx = istDayIndex(nowMs);
  const openIdx = istDayIndex(open);

  if (openIdx === todayIdx) return "Opens today at 9:15 AM IST";
  if (openIdx === todayIdx + 1) return "Opens tomorrow at 9:15 AM IST";

  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
  }).format(new Date(open));
  return `Opens ${dayName} at 9:15 AM IST`;
}

export interface MarketStatus {
  isOpen: boolean;
  reason: "OPEN" | "WEEKEND" | "HOLIDAY" | "OUTSIDE_HOURS";
  statusText: string;
  nextSessionText: string;
}

export function getNSEMarketStatus(now: Date = new Date()): MarketStatus {
  const nowMs = now.getTime();
  const today = istDayIndex(nowMs);
  const msSinceMidnight = nowMs - dayStartEpoch(today);
  const weekday = weekdayOf(today);

  if (weekday === 0 || weekday === 6) {
    return {
      isOpen: false,
      reason: "WEEKEND",
      statusText: "Market Closed (Weekend)",
      nextSessionText: describeNextOpen(nowMs),
    };
  }

  if (NSE_HOLIDAYS.has(dateKey(today))) {
    return {
      isOpen: false,
      reason: "HOLIDAY",
      statusText: "Market Closed (Trading Holiday)",
      nextSessionText: describeNextOpen(nowMs),
    };
  }

  if (msSinceMidnight < MARKET_OPEN_MS) {
    return {
      isOpen: false,
      reason: "OUTSIDE_HOURS",
      statusText: "Pre-Market / Closed",
      nextSessionText: describeNextOpen(nowMs),
    };
  }

  if (msSinceMidnight >= MARKET_CLOSE_MS) {
    return {
      isOpen: false,
      reason: "OUTSIDE_HOURS",
      statusText: "Market Closed",
      nextSessionText: describeNextOpen(nowMs),
    };
  }

  return {
    isOpen: true,
    reason: "OPEN",
    statusText: "LIVE (NSE)",
    nextSessionText: "Session ends at 3:30 PM IST",
  };
}
