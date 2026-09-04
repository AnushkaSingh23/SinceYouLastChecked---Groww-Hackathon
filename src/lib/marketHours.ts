// Knows whether NSE (India) is actually open right now, so the app can show
// an honest "market closed" state instead of a generic staleness timer.
//
// This hackathon's window (Fri Sep 4, 11am IST -> Mon Sep 7, 11am IST 2026)
// covers two live NSE sessions: Friday 11:00am-3:30pm IST, and Monday
// 9:15-11:00am IST. Sat/Sun are closed. Verified against NSE's published
// September 2026 holiday list: the only trading holiday that month is
// Ganesh Chaturthi on Sep 14, which falls outside this window — so Sep 4
// and Sep 7 are both ordinary trading days, no holiday special-casing needed
// for this hackathon's dates specifically.

const MARKET_OPEN_MINUTES = 9 * 60 + 15; // 9:15 AM IST
const MARKET_CLOSE_MINUTES = 15 * 60 + 30; // 3:30 PM IST

// Known NSE trading holidays that could matter if this runs past the
// hackathon window. Not a complete year calendar — extend if needed.
const NSE_HOLIDAYS_2026 = new Set([
  "2026-09-14", // Ganesh Chaturthi
]);

function istPartsNow(now: Date): { dateKey: string; weekday: number; minutesSinceMidnight: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return {
    dateKey,
    weekday: weekdayMap[parts.weekday],
    minutesSinceMidnight: hour * 60 + Number(parts.minute),
  };
}

export interface MarketStatus {
  isOpen: boolean;
  reason: "OPEN" | "WEEKEND" | "HOLIDAY" | "OUTSIDE_HOURS";
  statusText: string;
  nextSessionText: string;
}

export function getNSEMarketStatus(now: Date = new Date()): MarketStatus {
  const { dateKey, weekday, minutesSinceMidnight } = istPartsNow(now);

  if (weekday === 0 || weekday === 6) {
    return {
      isOpen: false,
      reason: "WEEKEND",
      statusText: "Market Closed (Weekend)",
      nextSessionText: "Opens Monday at 9:15 AM IST",
    };
  }

  if (NSE_HOLIDAYS_2026.has(dateKey)) {
    return {
      isOpen: false,
      reason: "HOLIDAY",
      statusText: "Market Closed (Trading Holiday)",
      nextSessionText: "Opens next trading day at 9:15 AM IST",
    };
  }

  if (minutesSinceMidnight < MARKET_OPEN_MINUTES) {
    return {
      isOpen: false,
      reason: "OUTSIDE_HOURS",
      statusText: "Pre-Market / Closed",
      nextSessionText: "Opens today at 9:15 AM IST",
    };
  }

  if (minutesSinceMidnight >= MARKET_CLOSE_MINUTES) {
    return {
      isOpen: false,
      reason: "OUTSIDE_HOURS",
      statusText: "Market Closed",
      nextSessionText: "Opens next trading day at 9:15 AM IST",
    };
  }

  return {
    isOpen: true,
    reason: "OPEN",
    statusText: "LIVE (NSE)",
    nextSessionText: "Session ends at 3:30 PM IST",
  };
}
