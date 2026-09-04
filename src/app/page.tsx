"use client";

import { useCallback, useEffect, useState } from "react";
import { NSE_40_UNIVERSE } from "@/lib/nseUniverse";

type Tier = "CRITICAL" | "NOTABLE" | "QUIET";

interface AttentionCard {
  symbol: string;
  currentPrice: number;
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

interface WatchlistItemData {
  symbol: string;
  name: string;
  addedAt: string;
  lastSeenAt: string | null;
  card: AttentionCard | null;
}

interface MarketStatus {
  isOpen: boolean;
  reason: string;
  statusText: string;
  nextSessionText: string;
}

interface WatchlistResponse {
  marketStatus: MarketStatus;
  lastPollAt: number | null;
  items: WatchlistItemData[];
}

const TIER_STYLES: Record<Tier, string> = {
  CRITICAL: "border-red-500/60 bg-red-500/10",
  NOTABLE: "border-amber-500/60 bg-amber-500/10",
  QUIET: "border-neutral-800 bg-neutral-900/20 opacity-70",
};

const TIER_RANK: Record<Tier, number> = { CRITICAL: 2, NOTABLE: 1, QUIET: 0 };

const TIER_BADGE: Record<Tier, string> = {
  CRITICAL: "bg-red-500 text-white",
  NOTABLE: "bg-amber-500 text-black",
  QUIET: "bg-neutral-700 text-neutral-200",
};

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

  return { handle, identify };
}

function IdentityGate({ onIdentify }: { onIdentify: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto mt-24 max-w-sm px-4 text-center">
      <h1 className="text-xl font-semibold">Since You Last Checked</h1>
      <p className="mt-2 text-sm text-neutral-400">
        Enter a name to create or return to your watchlist. No password — the same name on any
        device brings back the same watchlist.
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
        <input
          className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-400"
          placeholder="e.g. anushka"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {busy ? "..." : "Continue"}
        </button>
      </form>
    </div>
  );
}

function MarketStatusBanner({ status, lastPollAt }: { status: MarketStatus; lastPollAt: number | null }) {
  return (
    <div className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/60 px-4 py-2 text-sm">
      <span className={status.isOpen ? "text-emerald-400" : "text-neutral-400"}>
        {status.isOpen ? "● " : "○ "}
        {status.statusText}
      </span>
      <span className="text-neutral-500">
        {status.nextSessionText}
        {lastPollAt ? ` · data as of ${new Date(lastPollAt).toLocaleTimeString("en-IN")}` : ""}
      </span>
    </div>
  );
}

function Card({ item, onRemove }: { item: WatchlistItemData; onRemove: (symbol: string) => void }) {
  const c = item.card;
  const tier: Tier = c?.tier ?? "QUIET";

  return (
    <div className={`rounded-lg border p-4 ${TIER_STYLES[tier]}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium">{item.name}</div>
          <div className="text-xs text-neutral-500">{item.symbol}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${TIER_BADGE[tier]}`}>{tier}</span>
          <button onClick={() => onRemove(item.symbol)} className="text-xs text-neutral-500 hover:text-neutral-300">
            remove
          </button>
        </div>
      </div>

      {c ? (
        <>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-lg font-semibold">₹{c.currentPrice.toFixed(2)}</span>
            <span className={c.priceChangePct >= 0 ? "text-emerald-400" : "text-red-400"}>
              {c.priceChangePct >= 0 ? "+" : ""}
              {(c.priceChangePct * 100).toFixed(2)}%
            </span>
            {c.zScore !== null && <span className="text-xs text-neutral-500">({c.zScore.toFixed(1)}σ)</span>}
          </div>
          <p className="mt-2 text-sm text-neutral-300">{c.primaryReason}</p>
          {c.secondaryReasons.map((r, i) => (
            <p key={i} className="text-xs text-neutral-500">
              {r}
            </p>
          ))}
          <div className="mt-3 text-xs text-neutral-600">
            {c.volatilityIsLive ? "live volatility" : "seed volatility (warming up)"} · data{" "}
            {c.dataFreshnessSec < 60 ? `${c.dataFreshnessSec}s` : `${Math.round(c.dataFreshnessSec / 60)}m`} old
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-neutral-500">Waiting for first live quote…</p>
      )}
    </div>
  );
}

export default function Home() {
  const { handle, identify } = useIdentity();
  const [data, setData] = useState<WatchlistResponse | null>(null);
  const [addSymbol, setAddSymbol] = useState("");

  const refresh = useCallback(() => {
    fetch("/api/watchlist")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d));
  }, []);

  useEffect(() => {
    if (handle && typeof handle === "string") {
      refresh();
      const id = setInterval(refresh, 15_000);
      return () => clearInterval(id);
    }
  }, [handle, refresh]);

  if (handle === "loading") return null;
  if (!handle) return <IdentityGate onIdentify={identify} />;

  const watchedSymbols = new Set(data?.items.map((i) => i.symbol));
  const available = NSE_40_UNIVERSE.filter((s) => !watchedSymbols.has(s.symbol));

  // "Don't make me scan everything" — sort by what deserves attention first,
  // and separate the unchanged so it can be visually demoted, not just
  // rendered in whatever order items happen to be in.
  const sorted = [...(data?.items ?? [])].sort((a, b) => {
    const rankDiff = TIER_RANK[b.card?.tier ?? "QUIET"] - TIER_RANK[a.card?.tier ?? "QUIET"];
    if (rankDiff !== 0) return rankDiff;
    return Math.abs(b.card?.zScore ?? 0) - Math.abs(a.card?.zScore ?? 0);
  });
  const needsAttention = sorted.filter((i) => i.card && i.card.tier !== "QUIET");
  const unchanged = sorted.filter((i) => !i.card || i.card.tier === "QUIET");

  const removeSymbol = async (symbol: string) => {
    await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
    refresh();
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Since You Last Checked</h1>
        <span className="text-sm text-neutral-500">{handle}</span>
      </div>

      {data && <MarketStatusBanner status={data.marketStatus} lastPollAt={data.lastPollAt} />}

      <div className="mt-4 flex gap-2">
        <select
          className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          value={addSymbol}
          onChange={(e) => setAddSymbol(e.target.value)}
        >
          <option value="">Add a stock…</option>
          {available.map((s) => (
            <option key={s.symbol} value={s.symbol}>
              {s.name} ({s.symbol})
            </option>
          ))}
        </select>
        <button
          disabled={!addSymbol}
          onClick={async () => {
            await fetch("/api/watchlist", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ symbol: addSymbol }),
            });
            setAddSymbol("");
            refresh();
          }}
          className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {data && data.items.length > 0 && (
        <button
          onClick={async () => {
            await fetch("/api/watchlist/mark-seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
            refresh();
          }}
          className="mt-4 w-full rounded border border-neutral-700 py-2 text-sm text-neutral-300 hover:bg-neutral-900"
        >
          Mark all as seen
        </button>
      )}

      {data && data.items.length > 0 && (
        <p className="mt-4 text-sm text-neutral-400">
          {needsAttention.length === 0
            ? `Nothing needs your attention — all ${data.items.length} quiet.`
            : `${needsAttention.length} of ${data.items.length} need your attention.`}
        </p>
      )}

      {needsAttention.length > 0 && (
        <div className="mt-3 space-y-3">
          {needsAttention.map((item) => (
            <Card key={item.symbol} item={item} onRemove={removeSymbol} />
          ))}
        </div>
      )}

      {unchanged.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-xs uppercase tracking-wide text-neutral-600">
            {needsAttention.length > 0 ? "Unchanged" : "Your watchlist"}
          </p>
          <div className="space-y-2">
            {unchanged.map((item) => (
              <Card key={item.symbol} item={item} onRemove={removeSymbol} />
            ))}
          </div>
        </div>
      )}

      {data && data.items.length === 0 && (
        <p className="mt-6 text-center text-sm text-neutral-500">Your watchlist is empty — add a stock above.</p>
      )}
    </main>
  );
}
