"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Import the card shape from where it's actually defined instead of
// hand-duplicating it here — a hand-copied interface already drifted once
// (this file was missing `zScoreClamped` until it was added by hand at the
// same time as scoring.ts, a near-miss that a type-only import removes as a
// whole category of risk: the compiler catches drift instead of a human
// having to notice it). Type-only import, erased at compile time — no
// runtime cost, and scoring.ts has no server-only dependencies.
import { SCORING_THRESHOLDS } from "@/lib/scoring";
import type { Tier, AttentionCard } from "@/lib/scoring";
import type { LongTermTrend } from "@/lib/longTermTrend";

interface WatchlistItemData {
  symbol: string;
  name: string;
  sector: string | null;
  addedAt: string;
  lastSeenAt: string | null;
  card: AttentionCard | null;
  trend: LongTermTrend | null;
}

interface MarketStatus {
  isOpen: boolean;
  reason: string;
  statusText: string;
  nextSessionText: string;
}

interface FeedHealth {
  lastSuccessfulPollAt: number | null;
  lastPollAt: number | null;
  consecutiveFailures: number;
  symbolsResolved: number;
  symbolsAttempted: number;
  degraded: boolean;
}

interface WatchlistResponse {
  marketStatus: MarketStatus;
  lastPollAt: number | null;
  feedHealth: FeedHealth;
  items: WatchlistItemData[];
}

// ---------------------------------------------------------------------------
// Formatting
//
// Everything money- and time-shaped goes through one of these. Prices used to
// render as ₹142850.00 with no Indian digit grouping, and timestamps used the
// en-IN *format* without the IST *zone* — so a reviewer abroad saw an
// Indian-styled time that wasn't IST, in an app whose every other surface
// (market hours, session text, ₹) is IST-anchored.
// ---------------------------------------------------------------------------

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const formatINR = (n: number) => INR.format(n);

const IST_CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const IST_DAY_CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** Coarse "how long ago", with hour and day rollover — a raw minutes figure renders as "4020m" over a weekend. */
function relativeTime(fromMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (sec < 90) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.round(hr / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Same rollover problem, shorter form, for the per-card data-age line. */
function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}

// Tier styling. Each tier carries a glyph as well as a colour so the signal
// isn't encoded by colour alone, and every value here reads correctly in both
// light and dark mode (the `/N` alpha backgrounds sit on --surface, and the
// solid badge colours carry their own contrasting foreground).
const TIER_CONFIG: Record<Tier, { card: string; badge: string; glyph: string; rank: number }> = {
  CRITICAL: { card: "border-red-500 bg-red-500/10", badge: "bg-red-600 text-white", glyph: "▲", rank: 2 },
  NOTABLE: { card: "border-amber-500 bg-amber-500/10", badge: "bg-amber-500 text-black", glyph: "●", rank: 1 },
  NEW: { card: "border-sky-500/70 bg-sky-500/10", badge: "bg-sky-600 text-white", glyph: "✦", rank: 0 },
  QUIET: { card: "border-line bg-surface", badge: "bg-surface-muted text-fg-muted", glyph: "–", rank: 0 },
};

type TabId = "ALL" | "ATTENTION" | "NEW" | "QUIET";

// "All" stays the default and renders exactly the stacked, priority-sorted
// view the app has always had — the tabs narrow it, they don't replace it.
// That matters: landing on a filtered tab that happens to be empty would hide
// the fact that everything is fine, which is itself the answer most days.
const TABS: { id: TabId; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "ATTENTION", label: "Needs attention" },
  { id: "NEW", label: "New" },
  { id: "QUIET", label: "Unchanged" },
];

// Dev/demo presets — NSE is only live ~6 hours total across this hackathon's
// window, so this is how CRITICAL/NOTABLE states get demonstrated on demand
// rather than waiting for the market to cooperate. See shockInjector.ts.
// Every preset used to carry a price move of at least 1%, and every one of them
// came out CRITICAL — verified against the deployed app, five for five. Not an
// engine fault: a shock lands seconds after "mark as seen", so elapsed trading
// time sits at its floor and an ordinary move over that window is ~0.03%. Any
// 1% move is 30 sigma, clamped to 6.0σ+, red every time.
//
// That hid the two things most worth showing — that the engine discriminates at
// all, and that volume escalates on its own. So the set now spans the range.
//
// The volume-only entries are the reliable ones: with no price override there
// is no move to divide by a near-zero expected move, so their tier depends only
// on the ratio and comes out the same every time, on any stock, at any elapsed
// time. The price-driven ones are inherently CRITICAL for the reason above, and
// that is fine — they tell the "something happened to this company" story.
const SHOCK_PRESETS = [
  // Volume alone, below the surge threshold -> NOTABLE.
  { priceOverridePct: 0, volumeAnomalyRatio: 2.2, headline: "Unusual volume ahead of a scheduled board meeting" },
  // Price + volume together -> CRITICAL.
  { priceOverridePct: -0.062, volumeAnomalyRatio: 4.1, headline: "Q2 earnings miss street estimates by 9%" },
  // Volume alone, a confirmed surge -> CRITICAL with no price move at all.
  // This is the clearest demonstration of volume-driven escalation.
  { priceOverridePct: 0, volumeAnomalyRatio: 4.5, headline: "Block deal reported on the exchange" },
  // Elevated volume, flat price -> NOTABLE again, different story.
  { priceOverridePct: 0, volumeAnomalyRatio: 2.6, headline: "Bulk deal chatter ahead of results" },
  // A large upward move -> CRITICAL.
  { priceOverridePct: 0.081, volumeAnomalyRatio: 5.3, headline: "Board approves surprise share buyback" },
];

function useIdentity() {
  const [handle, setHandle] = useState<string | null | "loading">("loading");

  useEffect(() => {
    fetch("/api/identity")
      .then((r) => r.json())
      .then((d) => setHandle(d.user?.handle ?? null))
      .catch(() => setHandle(null));
  }, []);

  const identify = useCallback(async (name: string) => {
    const res = await fetch("/api/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: name }),
    });
    const d = await res.json();
    if (d.user) setHandle(d.user.handle);
    return d;
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/identity", { method: "DELETE" });
    setHandle(null);
  }, []);

  return { handle, identify, signOut };
}

function IdentityGate({ onIdentify }: { onIdentify: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto mt-24 max-w-sm px-4 text-center">
      <h1 className="text-xl font-semibold">Since You Last Checked</h1>
      <p className="mt-1 text-sm text-fg-muted">
        A smart NSE watchlist that surfaces what actually changed while you were away.
      </p>
      <p className="mt-4 text-sm text-fg-muted">
        Enter a name to create or return to your watchlist. No password — the same name on any
        device brings back the same watchlist.
      </p>
      {/* Said plainly rather than left to be discovered. The no-password
          design is a deliberate trade-off (see README), but a reader who
          assumes their list is private is being misled by omission. */}
      <p className="mt-2 text-xs text-fg-faint">
        There&rsquo;s no password, so this isn&rsquo;t private — anyone who enters the same name
        sees the same watchlist. Use a name you don&rsquo;t mind sharing.
      </p>
      <form
        className="mt-6 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          await onIdentify(name.trim());
          setBusy(false);
        }}
      >
        <label htmlFor="handle" className="sr-only">
          Your name
        </label>
        <input
          id="handle"
          className="flex-1 rounded border border-line-strong bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-fg-muted"
          placeholder="e.g. anushka"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-btn px-4 py-2 text-sm font-medium text-btn-fg disabled:opacity-50"
        >
          {busy ? "..." : "Continue"}
        </button>
      </form>
    </div>
  );
}

const TREND_LABEL_STYLE: Record<LongTermTrend["label"], string> = {
  Upward: "text-pos",
  Downward: "text-neg",
  Mixed: "text-fg-muted",
};

function TrendStat({ label, pct }: { label: string; pct: number | null }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-fg-faint">{label}</span>
      {pct === null ? (
        <span className="text-fg-faint">—</span>
      ) : (
        <span className={pct >= 0 ? "text-pos" : "text-neg"}>
          {pct >= 0 ? "+" : ""}
          {(pct * 100).toFixed(1)}%
        </span>
      )}
    </div>
  );
}

// Secondary to "Since You Last Checked" by design — smaller text, muted
// heading, placed below the primary content and the demo controls, not
// competing with the tier badge/color for attention.
function TrendSection({ trend }: { trend: LongTermTrend | null }) {
  if (!trend) return null;
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-fg-faint">Longer-Term Trend</span>
        <span className={`text-[11px] font-medium ${TREND_LABEL_STYLE[trend.label]}`}>{trend.label}</span>
      </div>
      <div className="flex justify-between text-xs">
        <TrendStat label="1M" pct={trend.oneMonthPct} />
        <TrendStat label="3M" pct={trend.threeMonthPct} />
        <TrendStat label="6M" pct={trend.sixMonthPct} />
        <TrendStat label="1Y" pct={trend.oneYearPct} />
      </div>
    </div>
  );
}

function MarketStatusBanner({
  status,
  lastPollAt,
  feedHealth,
}: {
  status: MarketStatus;
  lastPollAt: number | null;
  feedHealth: FeedHealth | undefined;
}) {
  // Only ever claim a freshness time we actually have data for. The banner
  // used to print the time of the last *attempt*, so it stayed confident
  // while every symbol was failing — contradicting the per-card age line.
  const asOf = lastPollAt ? `data as of ${IST_CLOCK.format(new Date(lastPollAt))} IST` : "waiting for first quote";

  return (
    <div className="rounded border border-line bg-surface px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className={status.isOpen ? "text-pos" : "text-fg-muted"}>
          {status.isOpen ? "● " : "○ "}
          {status.statusText}
        </span>
        <span className="text-fg-muted">
          {status.nextSessionText} · {asOf}
        </span>
      </div>
      {feedHealth?.degraded && (
        <p className="mt-1 text-xs text-neg">
          Live feed unavailable ({feedHealth.consecutiveFailures} failed{" "}
          {feedHealth.consecutiveFailures === 1 ? "cycle" : "cycles"}) — showing last known prices.
        </p>
      )}
    </div>
  );
}

/**
 * Percentages in the calculation panel need enough precision to actually
 * reconcile: an expected move of 0.034% printed as "0.03%" turns the division
 * shown next to it into visible nonsense.
 */
function pctPrecise(fraction: number): string {
  const v = Math.abs(fraction * 100);
  const digits = v < 0.1 ? 3 : 2;
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** One labelled line of the calculation. */
function CalcRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-fg-faint">{label}</span>
      <span className="text-right">
        <span className="font-mono text-fg">{value}</span>
        {note && <span className="ml-1.5 text-fg-faint">{note}</span>}
      </span>
    </div>
  );
}

/**
 * Shows the actual arithmetic behind the tier, with this card's real numbers.
 *
 * The app claims every flag has a real answer to "why?". A sigma value is only
 * that answer if you can see what went into it — otherwise "5.9σ" is exactly
 * the black-box score the product says it isn't. Collapsed by default so it
 * stays out of the way of the plain-English reason.
 */
function HowIsThisCalculated({ c, lastSeenMs }: { c: AttentionCard; lastSeenMs: number | null }) {
  if (c.zScore === null || c.expectedMovePct === null || c.lastSeenPrice === null) return null;

  const tradingMin = c.tradingElapsedMs !== null ? Math.round(c.tradingElapsedMs / 60_000) : null;
  const parts = [
    tradingMin === null || tradingMin < 1
      ? null
      : tradingMin < 60
        ? `${tradingMin} min`
        : `${(tradingMin / 60).toFixed(1)} hr`,
    c.sessionsMissed > 0 ? `${c.sessionsMissed} market ${c.sessionsMissed === 1 ? "open" : "opens"}` : null,
  ].filter(Boolean);
  // Zero trading minutes is the normal case outside market hours, not an error.
  const awayText = parts.length > 0 ? parts.join(" + ") : "none — market was closed";

  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer list-none text-fg-muted underline decoration-dotted underline-offset-2 hover:text-fg">
        How is this calculated? ▾
      </summary>

      <div className="mt-2 space-y-0.5 rounded border border-line bg-surface-muted px-3 py-2">
        <CalcRow
          label="Your baseline"
          value={formatINR(c.lastSeenPrice)}
          note={lastSeenMs !== null ? IST_DAY_CLOCK.format(new Date(lastSeenMs)) + " IST" : undefined}
        />
        <CalcRow label="Now" value={formatINR(c.currentPrice)} />
        <CalcRow
          label="Move since then"
          value={`${c.priceChangePct >= 0 ? "+" : ""}${(c.priceChangePct * 100).toFixed(2)}%`}
        />
        <CalcRow label="Trading time away" value={awayText || "under a minute"} note="market hours only" />

        <div className="my-1.5 border-t border-line" />

        <CalcRow
          label="This stock's daily swing"
          value={`±${((c.sigmaDaily ?? 0) * 100).toFixed(2)}%`}
          note={c.volatilityIsLive ? "measured live" : "from 3-month history"}
        />
        <CalcRow
          label="Ordinary move for that window"
          value={`±${pctPrecise(c.expectedMovePct)}`}
          note="σ × √time"
        />
        <CalcRow
          label="So this move is"
          value={`${c.zScore.toFixed(1)}σ${c.zScoreClamped ? "+" : ""}`}
          // When the value is capped, showing the division alongside it prints
          // arithmetic that doesn't reconcile. Say what was actually capped.
          note={
            c.zScoreClamped && c.zScoreRaw !== null
              ? `capped for display · actually ${c.zScoreRaw.toFixed(0)}σ`
              : `${pctPrecise(Math.abs(c.priceChangePct))} ÷ ${pctPrecise(c.expectedMovePct)}`
          }
        />

        <p className="pt-1.5 text-fg-faint">
          Under {SCORING_THRESHOLDS.zNotable}σ is quiet · {SCORING_THRESHOLDS.zNotable}–
          {SCORING_THRESHOLDS.zCritical}σ is notable · {SCORING_THRESHOLDS.zCritical}σ+ is critical.
        </p>

        {c.volumeRatio !== null && c.volumeLevel !== "NORMAL" && (
          <p className="text-fg-faint">
            Volume is {c.volumeRatio.toFixed(1)}× its recent pace ({SCORING_THRESHOLDS.volumeElevated}×+ counts,{" "}
            {SCORING_THRESHOLDS.volumeSurge}×+ held for two polls is critical on its own).
          </p>
        )}

        {c.benchmarkChangePct !== null && c.relativeChangePct !== null && (
          <p className="text-fg-faint">
            {Math.abs(c.benchmarkChangePct) < 0.001 ? (
              <>
                {c.benchmarkName} was flat over the same window, so this move was the stock, not the market.
              </>
            ) : (
              <>
                {c.benchmarkName} moved {(c.benchmarkChangePct * 100).toFixed(2)}% over the same window, so{" "}
                {(c.relativeChangePct * 100).toFixed(2)}% of this is specific to the stock
                {c.isMarketDriven
                  ? " — most of the move was the market, so the tier was stepped down one level."
                  : "."}
              </>
            )}
          </p>
        )}
      </div>
    </details>
  );
}

function Card({
  item,
  now,
  onRemove,
  onMarkSeen,
  onSimulate,
  onClearSimulation,
}: {
  item: WatchlistItemData;
  now: number;
  onRemove: (symbol: string) => void;
  onMarkSeen: (symbol: string) => void;
  onSimulate: (symbol: string) => void;
  onClearSimulation: (symbol: string) => void;
}) {
  const c = item.card;
  const tier: Tier = c?.tier ?? "QUIET";
  const cfg = TIER_CONFIG[tier];
  const lastSeenMs = item.lastSeenAt ? new Date(item.lastSeenAt).getTime() : null;

  return (
    <div className={`rounded-lg border p-4 ${cfg.card}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium">{item.name}</div>
          <div className="text-xs text-fg-faint">
            {item.symbol}
            {item.sector ? ` · ${item.sector}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${cfg.badge}`}>
            <span aria-hidden="true">{cfg.glyph} </span>
            {tier}
          </span>
          <button
            onClick={() => onRemove(item.symbol)}
            aria-label={`Remove ${item.name} from watchlist`}
            className="text-xs text-fg-faint hover:text-fg"
          >
            remove
          </button>
        </div>
      </div>

      {c ? (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-lg font-semibold">{formatINR(c.currentPrice)}</span>
            <span className={c.priceChangePct >= 0 ? "text-pos" : "text-neg"}>
              {c.priceChangePct >= 0 ? "+" : ""}
              {(c.priceChangePct * 100).toFixed(2)}%
            </span>
            <span className="text-xs text-fg-muted">
              ({c.priceChangeAbs >= 0 ? "+" : "−"}
              {formatINR(Math.abs(c.priceChangeAbs))})
            </span>
            {c.isSimulated && (
              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                SIMULATED
              </span>
            )}
          </div>

          {/* The diff the app is named after. Showing only the current price
              and a % left the "from" — the whole premise — implicit. */}
          {c.lastSeenPrice !== null && lastSeenMs !== null ? (
            <p className="mt-1 text-xs text-fg-muted">
              {formatINR(c.lastSeenPrice)} → {formatINR(c.currentPrice)} · last checked{" "}
              {IST_DAY_CLOCK.format(new Date(lastSeenMs))} IST ({relativeTime(lastSeenMs, now)})
              {c.sessionsMissed > 0 &&
                ` · ${c.sessionsMissed} market ${c.sessionsMissed === 1 ? "open" : "opens"} since`}
            </p>
          ) : (
            <p className="mt-1 text-xs text-fg-faint">
              Not checked yet — change shown against yesterday&rsquo;s close.
            </p>
          )}

          {/* Market context: the same move means opposite things depending on
              whether the whole market moved with it. */}
          {c.benchmarkChangePct !== null &&
            c.relativeChangePct !== null &&
            Math.abs(c.benchmarkChangePct) >= 0.001 && (
            <p className="mt-1 text-xs text-fg-muted">
              {c.benchmarkName} {c.benchmarkChangePct >= 0 ? "+" : ""}
              {(c.benchmarkChangePct * 100).toFixed(2)}% over the same window ·{" "}
              <span className={c.isMarketDriven ? "text-fg-faint" : "font-medium text-fg"}>
                {c.relativeChangePct >= 0 ? "+" : ""}
                {(c.relativeChangePct * 100).toFixed(2)}% vs the market
              </span>
            </p>
          )}

          <p className="mt-2 text-sm text-fg">{c.primaryReason}</p>
          {c.newsHeadline && <p className="mt-1 text-xs italic text-accent">&ldquo;{c.newsHeadline}&rdquo;</p>}
          {c.secondaryReasons.map((r) => (
            // Content itself as the key, not the array index — which
            // signal lands at which index can change between polls
            // depending on which conditions fire, so an index key risks
            // React reusing the wrong DOM node across a re-render.
            <p key={r} className="text-xs text-fg-muted">
              {r}
            </p>
          ))}

          <HowIsThisCalculated c={c} lastSeenMs={lastSeenMs} />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-fg-faint">
            <span>
              {c.volatilityIsLive ? "live volatility" : "seed volatility (warming up)"} · data{" "}
              {formatAge(c.dataFreshnessSec)} old
            </span>
            <span className="flex items-center gap-3">
              {tier !== "QUIET" && (
                <button
                  onClick={() => onMarkSeen(item.symbol)}
                  aria-label={`Mark ${item.name} as seen`}
                  className="text-fg-muted hover:text-fg"
                >
                  got it
                </button>
              )}
              {c.isSimulated ? (
                <button
                  onClick={() => onClearSimulation(item.symbol)}
                  aria-label={`Clear the simulated event on ${item.name}`}
                  className="text-accent hover:underline"
                >
                  clear simulation
                </button>
              ) : (
                <button
                  onClick={() => onSimulate(item.symbol)}
                  aria-label={`Simulate a market event on ${item.name}`}
                  className="text-fg-muted hover:text-fg"
                >
                  ⚡ simulate event
                </button>
              )}
            </span>
          </div>
          <TrendSection trend={item.trend} />
        </>
      ) : (
        <p className="mt-3 text-sm text-fg-muted">Waiting for first live quote…</p>
      )}
    </div>
  );
}

/**
 * Type-to-search combobox. Replaces a search box that only filtered a
 * separate <select> — two controls, two steps, and an "Add" button that
 * could stay enabled for a symbol the filter had just hidden.
 */
interface SymbolHit {
  symbol: string;
  name: string;
  sector: string | null;
}

/**
 * Live NSE symbol search.
 *
 * This used to filter a hardcoded 40-ticker array bundled into the browser,
 * which meant a real stock the user actually held — Tata Power, say — simply
 * could not be added, and shipped the whole table (sectors, volatility seeds)
 * into the client for a list the UI barely used. It now queries the exchange,
 * so anything tradeable on the NSE can be watched.
 */
function AddStock({
  watched,
  onAdd,
}: {
  watched: Set<string>;
  onAdd: (symbol: string, name: string) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolHit[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  // Monotonic id so a slow response for an earlier query can't overwrite the
  // results of a later one — the user types faster than the network replies.
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    const q = query.trim();

    // Debounced: one request per pause in typing, not one per keystroke.
    // `searching` is set in the change handler rather than here, so this
    // effect only ever updates state from the fetch callback.
    const id = setTimeout(() => {
      fetch(`/api/symbols/search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (mine !== seq.current) return;
          setResults(Array.isArray(d?.results) ? d.results : []);
          setSearching(false);
          setHighlight(0);
        })
        .catch(() => {
          if (mine === seq.current) setSearching(false);
        });
    }, q.length >= 2 ? 250 : 0);

    return () => clearTimeout(id);
  }, [query]);

  // Hide anything already on the watchlist — adding it again is a no-op.
  const matches = useMemo(
    () => results.filter((r) => !watched.has(r.symbol)).slice(0, 8),
    [results, watched]
  );

  const add = async (hit: SymbolHit) => {
    setBusy(true);
    const ok = await onAdd(hit.symbol, hit.name);
    setBusy(false);
    if (ok) {
      setQuery("");
      setResults([]);
      setOpen(false);
    }
  };

  const showList = open && matches.length > 0;
  const noMatches = open && !searching && query.trim().length >= 2 && matches.length === 0;

  return (
    <div className="relative mt-4">
      <label htmlFor="stock-search" className="sr-only">
        Search any NSE stock to add to your watchlist
      </label>
      <input
        id="stock-search"
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls="stock-search-results"
        aria-autocomplete="list"
        autoComplete="off"
        disabled={busy}
        className="w-full rounded border border-line-strong bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-fg-muted disabled:opacity-50"
        placeholder="Search any NSE stock by name or symbol…"
        value={query}
        onFocus={() => setOpen(true)}
        // Blur fires before click, so a plain onClick on a result would never
        // run. Delay just past the click, and let onMouseDown handle the pick.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          const next = e.target.value;
          setQuery(next);
          setSearching(next.trim().length >= 2);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!showList) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => (h + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => (h - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            void add(matches[highlight]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />

      {showList && (
        <ul
          id="stock-search-results"
          role="listbox"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded border border-line-strong bg-surface shadow-lg"
        >
          {matches.map((s, i) => (
            <li key={s.symbol} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void add(s);
                }}
                className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm ${
                  i === highlight ? "bg-surface-muted" : ""
                }`}
              >
                <span className="truncate">{s.name}</span>
                <span className="shrink-0 text-xs text-fg-faint">{s.symbol.replace(/\.NS$/, "")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {searching && !showList && (
        <p className="absolute z-10 mt-1 w-full rounded border border-line bg-surface px-3 py-2 text-sm text-fg-faint">
          Searching the NSE…
        </p>
      )}

      {noMatches && (
        <p className="absolute z-10 mt-1 w-full rounded border border-line bg-surface px-3 py-2 text-sm text-fg-muted">
          No NSE stocks match &ldquo;{query.trim()}&rdquo;.
        </p>
      )}
    </div>
  );
}

export default function Home() {
  const { handle, identify, signOut } = useIdentity();
  const [data, setData] = useState<WatchlistResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Re-rendered relative timestamps ("2 days ago") need a clock that ticks,
  // and taking it from state keeps server and first client render identical.
  const [now, setNow] = useState(() => Date.now());
  // View filter only — these are the three groups the scoring already
  // produces, not user-managed lists. No schema, no server state: switching
  // tabs re-filters data the page already has.
  const [tab, setTab] = useState<TabId>("ALL");
  // Monotonic request id: two in-flight refreshes can resolve out of order,
  // and an older response overwriting a newer one is the same class of bug
  // the server-side monotonicity guard fixes for quotes.
  const requestSeq = useRef(0);
  /** Cycles through the demo presets so repeated clicks show different tiers. */
  const presetIndex = useRef(0);

  const refresh = useCallback(() => {
    const seq = ++requestSeq.current;
    return fetch("/api/watchlist")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        // Drop a response that a newer request has already overtaken.
        if (json && seq === requestSeq.current) {
          setData(json);
          setNow(Date.now());
        }
      })
      .catch(() => {
        // A dropped refresh is not worth surfacing — the next tick retries
        // and the feed-health banner already reports a genuinely broken feed.
      });
  }, []);

  useEffect(() => {
    // "loading" is itself typeof "string", so a bare `typeof === "string"`
    // check (or a truthy check) matches the sentinel too — this used to
    // fire an authenticated fetch to /api/watchlist before identity
    // resolution even completed, on every page load. Harmless in practice
    // (it 401s and gets silently swallowed) but wrong: this guard means
    // "we have a real handle," and "loading" isn't one.
    if (handle && handle !== "loading") {
      void refresh();
      const id = setInterval(() => void refresh(), 15_000);
      return () => clearInterval(id);
    }
  }, [handle, refresh]);

  // Clear a transient notice after a few seconds so it doesn't linger.
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const watchedSymbols = useMemo(() => new Set(data?.items.map((i) => i.symbol)), [data]);
  // "Don't make me scan everything" — sort by what deserves attention first,
  // and separate the unchanged so it can be visually demoted, not just
  // rendered in whatever order items happen to be in.
  const sorted = useMemo(
    () =>
      [...(data?.items ?? [])].sort((a, b) => {
        const rankDiff = TIER_CONFIG[b.card?.tier ?? "QUIET"].rank - TIER_CONFIG[a.card?.tier ?? "QUIET"].rank;
        if (rankDiff !== 0) return rankDiff;
        return Math.abs(b.card?.zScore ?? 0) - Math.abs(a.card?.zScore ?? 0);
      }),
    [data]
  );

  if (handle === "loading") return null;
  if (!handle) return <IdentityGate onIdentify={identify} />;

  const needsAttention = sorted.filter((i) => i.card && i.card.tier !== "QUIET" && i.card.tier !== "NEW");
  const newItems = sorted.filter((i) => i.card?.tier === "NEW");
  const unchanged = sorted.filter((i) => !i.card || i.card.tier === "QUIET");
  const counts: Record<TabId, number> = {
    ALL: sorted.length,
    ATTENTION: needsAttention.length,
    NEW: newItems.length,
    QUIET: unchanged.length,
  };

  const addStock = async (symbol: string, name: string) => {
    const res = await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Pass the name through from the search result so the card is labelled
      // correctly without a second lookup.
      body: JSON.stringify({ symbol, name }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setNotice(d?.error ?? "Couldn't add that stock — try again.");
      return false;
    }
    await refresh();
    return true;
  };

  const removeSymbol = async (symbol: string) => {
    await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
    await refresh();
  };

  const markSeen = async (symbol?: string) => {
    const res = await fetch("/api/watchlist/mark-seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(symbol ? { symbol } : {}),
    });
    // Tell the user what actually happened. Clicking this before the feed has
    // warmed up used to mark nothing, show no error, and silently leave the
    // baseline unset.
    if (res.ok) {
      const d = await res.json();
      if (d.updated === 0) setNotice("Nothing marked yet — still waiting for the first live quote.");
      else if (d.skipped > 0) setNotice(`Baseline set for ${d.updated}; ${d.skipped} had no quote yet.`);
      else setNotice(`Baseline set for ${d.updated} ${d.updated === 1 ? "stock" : "stocks"}.`);
    } else {
      setNotice("Couldn't set the baseline — try again.");
    }
    await refresh();
  };

  const simulateEvent = async (symbol: string) => {
    // Rotate rather than pick at random: a random draw can repeat the same
    // preset several times running, which is exactly what makes the tiering
    // look like it only has one state.
    const preset = SHOCK_PRESETS[presetIndex.current % SHOCK_PRESETS.length];
    presetIndex.current += 1;
    const res = await fetch("/api/dev/shock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, ...preset }),
    });
    if (!res.ok) setNotice("Simulated events are disabled on this deployment.");
    await refresh();
  };

  const clearSimulation = async (symbol: string) => {
    await fetch(`/api/dev/shock?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
    await refresh();
  };

  const cardProps = {
    now,
    onRemove: removeSymbol,
    onMarkSeen: (s: string) => void markSeen(s),
    onSimulate: simulateEvent,
    onClearSimulation: clearSimulation,
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Since You Last Checked</h1>
          <p className="text-xs text-fg-faint">
            A smart NSE watchlist that surfaces what actually changed while you were away.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-fg-muted">{handle}</span>
          <button
            onClick={() => {
              // Clear the locally-rendered watchlist too, so the next person
              // to type a name never sees a flash of someone else's list.
              setData(null);
              void signOut();
            }}
            className="text-fg-faint underline underline-offset-2 hover:text-fg"
          >
            switch
          </button>
        </div>
      </div>

      {data && (
        <MarketStatusBanner status={data.marketStatus} lastPollAt={data.lastPollAt} feedHealth={data.feedHealth} />
      )}

      <AddStock watched={watchedSymbols} onAdd={addStock} />

      {data && data.items.length > 0 && (
        <button
          onClick={() => void markSeen()}
          className="mt-3 w-full rounded border border-line-strong py-2 text-sm text-fg-muted hover:bg-surface-muted hover:text-fg"
        >
          Mark all as seen
        </button>
      )}

      {data?.items.some((i) => i.card?.isSimulated) && (
        <button
          onClick={async () => {
            await fetch("/api/dev/shock", { method: "DELETE" });
            await refresh();
          }}
          className="mt-2 w-full rounded border border-accent/50 py-1.5 text-xs text-accent hover:bg-accent/10"
        >
          Clear all simulated events
        </button>
      )}

      {/* Both the attention summary and transient notices are announced —
          content changes every 15s with no other cue for a screen reader. */}
      <div aria-live="polite" className="min-h-[1.5rem]">
        {notice && <p className="mt-4 text-sm text-accent">{notice}</p>}
        {!notice && data && data.items.length > 0 && (
          <p className="mt-4 text-sm text-fg-muted">
            {needsAttention.length === 0
              ? unchanged.length > 0
                ? `Nothing needs your attention — ${unchanged.length} quiet.`
                : "New stocks below — check back later to see what changes."
              : `${needsAttention.length} of ${data.items.length} need your attention.`}
          </p>
        )}
      </div>

      {data && data.items.length > 0 && (
        <div role="tablist" aria-label="Filter watchlist" className="mt-4 flex flex-wrap gap-1 border-b border-line">
          {TABS.map((t) => {
            const count = counts[t.id];
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`-mb-px rounded-t border-b-2 px-3 py-1.5 text-sm ${
                  active
                    ? "border-fg font-medium text-fg"
                    : "border-transparent text-fg-muted hover:text-fg"
                }`}
              >
                {t.label}
                <span className="ml-1.5 text-xs text-fg-faint">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {(tab === "ALL" || tab === "ATTENTION") && needsAttention.length > 0 && (
        <div className="mt-4 space-y-3">
          {needsAttention.map((item) => (
            <Card key={item.symbol} item={item} {...cardProps} />
          ))}
        </div>
      )}

      {(tab === "ALL" || tab === "NEW") && newItems.length > 0 && (
        <div className="mt-6">
          {/* The heading is redundant once a tab already names the group. */}
          {tab === "ALL" && <p className="mb-2 text-xs uppercase tracking-wide text-fg-faint">New</p>}
          <div className="space-y-2">
            {newItems.map((item) => (
              <Card key={item.symbol} item={item} {...cardProps} />
            ))}
          </div>
        </div>
      )}

      {(tab === "ALL" || tab === "QUIET") && unchanged.length > 0 && (
        <div className="mt-6">
          {tab === "ALL" && (
            <p className="mb-2 text-xs uppercase tracking-wide text-fg-faint">
              {needsAttention.length > 0 || newItems.length > 0 ? "Unchanged" : "Your watchlist"}
            </p>
          )}
          <div className="space-y-2">
            {unchanged.map((item) => (
              <Card key={item.symbol} item={item} {...cardProps} />
            ))}
          </div>
        </div>
      )}

      {/* An empty tab needs to say so, or it reads as a broken page. */}
      {data && data.items.length > 0 && counts[tab] === 0 && (
        <p className="mt-6 text-center text-sm text-fg-muted">
          {tab === "ATTENTION"
            ? "Nothing needs your attention right now."
            : tab === "NEW"
              ? "No newly added stocks — everything here has a baseline."
              : "Nothing quiet — everything is flagged."}
        </p>
      )}

      {data && data.items.length === 0 && (
        <p className="mt-6 text-center text-sm text-fg-muted">Your watchlist is empty — add a stock above.</p>
      )}
    </main>
  );
}
