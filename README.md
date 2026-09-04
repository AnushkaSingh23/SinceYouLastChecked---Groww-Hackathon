# Since You Last Checked

A smart watchlist for NSE (Indian stock market) equities. Built for
**"Code, by Groww" — CODE 2026**.

Most watchlists show you every number and make you find what matters. This
one tracks what you've already seen, and only surfaces what actually earned
your attention since then — with a plain-English reason attached to every
flag, never just a badge.

## What it does

- Create and manage a watchlist from a curated set of 40 liquid NSE stocks.
- See live prices while the market is open (9:15am–3:30pm IST, Mon–Fri).
- Come back later and see a **"Since you last checked"** view: what changed,
  how much, and why — sorted by what deserves your attention, not by
  whatever order you added things in.
- "Meaningful change" is volatility-relative (a z-score against each stock's
  own behavior), not a flat percentage — the same 2% move reads very
  differently on a stable blue chip vs. a volatile growth stock.
- Honest about stale/closed-market data: the app knows real NSE trading
  hours and says so, instead of pretending to be live when it isn't.
- A dev-only **shock injector** lets you simulate a price/volume event with
  a headline on any watchlisted stock — since NSE is only open a few hours
  total across a typical demo window, this is how CRITICAL/NOTABLE states
  get shown on demand.

See `PROJECT_BRIEF.md`, `PRD.md`, `ARCHITECTURE.md`, and `DECISIONS.md` in
this repo for the full reasoning behind these choices (local-only files, not
tracked in git — see below).

## Setup

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
npx prisma migrate dev
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Enter any name to
create a watchlist — no password, no signup, no external API key needed.
The market data source (Yahoo Finance's public NSE quote endpoint) doesn't
require authentication.

`npm install` also runs `prisma generate` automatically (via `postinstall`).
If you ever change `prisma/schema.prisma`, re-run `npx prisma migrate dev`.

## Using it

1. Add a few stocks from the dropdown.
2. Click **"Mark all as seen"** to set a baseline.
3. Watch the "Since you last checked" view update live as the market moves
   (polls every ~20 seconds while NSE is open).
4. Outside market hours, or to demo a specific scenario immediately, use the
   **"⚡ simulate event"** button on any card — it injects a realistic price
   move, volume spike, and headline without touching real market data.

## Verifying it works

Standalone smoke tests (no test framework, just scripted assertions) cover
each phase of the build:

```bash
npx tsx smoketests/phase1-foundation.ts    # data foundation, no server needed
npx tsx smoketests/phase3-engine.ts        # scoring engine, no server needed

# the rest need `npm run dev` running in another terminal:
npx tsx smoketests/phase2-pipeline.ts      # market data pipeline + SSE
npx tsx smoketests/phase4-persistence.ts   # watchlist CRUD + persistence
npx tsx smoketests/phase5-shock-injector.ts # dev shock injector
```

A production build is also verified clean:

```bash
npm run build
npm start
```

## Notable engineering decisions

- **NSE, not US markets** — this is a Groww-inspired product for Groww's
  actual (Indian) users, and it turned out to also give a better live-data
  window for this specific hackathon's dates.
- **No historical price data dependency** — volatility is learned live from
  the running session (seeded with a sensible starting estimate per stock),
  not fetched from a fragile/gated historical-candles API.
- **In-memory live data, persisted user state** — the live quote cache and
  volatility trackers are in-memory (fine to lose on restart, they rebuild
  fast); the watchlist and "last seen" snapshots are in SQLite, because
  that's the state the product's whole premise depends on surviving a
  restart or a return visit days later.

Full write-up of these trade-offs, plus every bug hit and fixed along the
way, is in the local-only `DECISIONS.md` / `ERRORS.md` files.
