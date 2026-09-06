# Since You Last Checked

**A smart NSE watchlist that ranks what actually changed while you were away.**

Built for *Code, by Groww* — CODE 2026.

---

## The problem

A watchlist shows you forty rows of green and red numbers and leaves you the
hard part: **which of these actually matters?** You scan everything, every
time, and you still miss things.

This app answers that question instead of asking it.

## The two bets it makes

**1. A percentage is meaningless without context.**
A 2% move is a non-event for HDFC Bank and an emergency for Adani Enterprises.
So nothing here is ranked by raw percentage. Every move is scored against *that
specific stock's own* typical volatility — how unusual is this, **for this
stock**, in the time you were away.

**2. The useful unit is the diff since *your* last visit, not the price.**
That is why there is a sign-in at all, why "Mark as seen" exists, and why the
app measures elapsed time in **trading hours** rather than wall-clock hours.

Everything below follows from those two ideas.

---

## How the scoring works

Five independent signals combine into one tier per stock, and every tier traces
back to a plain-English sentence — so *"why was this flagged?"* always has a
real answer. There is no black-box score.

### 1. Volatility-relative price move

```
z = |% move since you last checked| / (σ × √(elapsed trading time))
```

- **σ** is the stock's daily-equivalent volatility. It starts from a seed
  **derived from that symbol's own 3-month price history**, then switches to
  **live-observed** volatility once enough real ticks arrive this session. The
  card tells you which is in use (`live volatility` vs `volatility from
  3-month history`) rather than hiding it.
- **√(elapsed time)** is standard square-root-of-time scaling — the same maths
  behind annualising a daily volatility. A move is more surprising the less time
  it had to happen in.

Thresholds: **z ≥ 1.5 → NOTABLE**, **z ≥ 3.0 → CRITICAL**.

### 2. Trading-time elapsed — the fix that makes the premise true

This is the most important piece of engineering in the project, and it started
as a bug that quietly broke the entire product.

The market is open **6h15m a day**. A Friday-evening-to-Monday-morning gap is
~66 *wall-clock* hours and roughly **zero trading hours**. Measuring elapsed
time with a wall clock bills that weekend as ~2.6 trading days of expected
drift, the `√t` denominator inflates, and the z-score collapses.

**The concrete failure:** a real 5% weekend gap scored **0.57σ → QUIET →
*"No notable activity since last check."*** On exactly the return visit the
product is named after.

`tradingElapsedBetween()` now walks the calendar day by day and counts only
genuine open-market milliseconds, skipping nights, weekends and known holidays.
It also returns **how many market opens you slept through**.

Overnight gaps are not treated as zero-risk — a shut market still reopens on
news that broke while it was closed. Each missed session open is charged a flat
**0.2 of a trading day** of variance (the standard empirical range is
0.15–0.25). Without that, a 9:16am check against a 6pm baseline would see ~1
minute of elapsed trading time and call every ordinary opening tick a 10σ event.

| Real 5% move, σ = 2.7% | Before | After |
|---|---|---|
| Friday close → Monday morning | 0.57σ · QUIET | **3.78σ · CRITICAL** |
| Thursday evening → Friday morning | 1.10σ · QUIET | **3.78σ · CRITICAL** |
| *Ordinary 0.4% move over a weekend* | — | *0.30σ · QUIET* |

That last row matters as much as the first two. Making real gaps loud is easy;
making them loud **without** making ordinary ones loud is the actual problem.

### 3. Volume — a graded signal, not a boolean

Yahoo reports cumulative day-volume, so the app tracks the **delta between
consecutive polls** and compares it to that stock's own recent pace.

| Ratio vs. recent pace | Level | Weight | Reaches alone |
|---|---|---|---|
| under 1.5× | Normal | 0 | — |
| 1.5× – 3× | Elevated | 1 | NOTABLE |
| 3×+, single poll | Surge | 1 | NOTABLE |
| **3×+, held ≥ 2 polls** | **Confirmed surge** | **2** | **CRITICAL** |

So rising volume genuinely escalates a stock QUIET → NOTABLE → CRITICAL with no
price signal required. Three robustness choices, each fixing an observed false
positive:

- **Median baseline, not mean.** A mean lets a surge inflate its own denominator
  and normalise itself away *while it is still happening*.
- **Zero deltas are excluded.** A poll where nothing traded is the *absence* of a
  pace measurement, not a measurement of zero pace. Including zeros made the
  first real print after a quiet stretch read as a ~30× anomaly.
- **A surge must hold for two polls to reach CRITICAL.** NSE volume is U-shaped;
  a single 20-second print at 3× is routine into the close. Without this,
  testing against the live feed at 3:10pm painted most of the list red on ~0.2%
  price moves.

### 4. Market-relative context — is it the stock, or the whole market?

The same drop means opposite things depending on what the market did:

| | | |
|---|---|---|
| ITC **−3.1%** | NIFTY 50 **−0.2%** | something happened to ITC |
| ITC **−3.1%** | NIFTY 50 **−2.9%** | the market fell; ITC came along |

Before this the app said the same thing for both — which is the single biggest
source of false urgency in an attention product. On a broad sell-off every card
turns red, all of it technically true, none of it news about any one stock.

Each symbol is judged against **NIFTY 50**, or **NIFTY Bank** for banks and
financials, which move together far more tightly than the market as a whole.
The index level is recorded alongside the price at "mark as seen", so the
comparison spans exactly the same window as the stock's own move — comparing a
since-you-last-checked move against the index's since-yesterday move would span
two different windows and mean nothing.

When the index explains most of the move, the tier steps **down one level** and
says so. Three deliberate limits on that:

- **Only when the price signal drove the tier.** A 52-week break or a confirmed
  volume surge is a fact about *this* stock that the index does not explain
  away, so those keep their tier.
- **Only when the stock moved *with* the market.** Falling while the market
  rises is the opposite of market-driven and is never softened.
- **Judged as a proportion, not a z-score on the residual.** Scoring the
  leftover by z makes the answer depend on how long you were away — over a
  20-second window a 0.2% divergence is already >5σ, so a market-wide drop would
  never be recognised on a short visit. "How much of this was the market?" is a
  question about decomposing the move, and should give the same answer at any
  elapsed time.

The residual uses beta = 1 rather than a fitted beta: a per-symbol beta needs
history this app doesn't keep, and "did it move more than the market?" is the
question people actually ask.

### 5. 52-week level breaks

Flags a stock crossing its 52-week high or low. If the data source omits a
bound, it is treated as **unknown**, never as "crossed" — defaulting a missing
bound to the current price makes `price >= high` trivially true forever.

### How tiers combine

```
weight ≥ 2  →  escalate one tier  (QUIET/NEW → NOTABLE → CRITICAL)
```

Two independent signals agreeing has always counted as more meaningful than
either alone. A confirmed volume surge now carries that weight by itself.

### `NEW` is a real state, not a fallback

A stock you have never checked has no baseline, so it cannot honestly have a
diff. It gets its own tier.

This matters more than it sounds. A stock added three seconds ago can genuinely
be at its 52-week high with genuinely unusual volume — two real signals that
would combine into a red `CRITICAL` about a stock with zero user history. That
is a false alarm on day one, precisely contrary to the point of the app. `NEW`
never escalates; the real facts still show as context.

---

### "How is this calculated?"

A sigma value is only an explanation if you can see what went into it —
otherwise `6.0σ` is exactly the black-box score this app claims not to be. Every
scored card has a collapsed panel showing the actual arithmetic with its own
numbers:

```
Your baseline                ₹264.10   Sat, 10:50 pm IST
Now                          ₹255.91
Move since then              -3.10%
Trading time away            none — market was closed

This stock's daily swing     ±1.14%    from 3-month history
Ordinary move for that window ±0.03%   σ × √time
So this move is              6.0σ+     3.10% ÷ 0.03%

Under 1.5σ is quiet · 1.5–3σ is notable · 3σ+ is critical.
```

The thresholds are imported from the scoring engine rather than retyped in the
UI, so the panel cannot drift out of sync with what actually decided the tier.

---

## Making "seen" actually mean something

**Mark all as seen** sets your baseline; **got it** acknowledges one card.

The snapshot records **what you acknowledged, not just the price**: the price,
the timestamp, whether it was at a 52-week bound, and the volume ratio.

Without that, "seen" only reset the price — so a stock sitting at its 52-week
high or in a volume surge **stayed flagged forever** no matter how many times
you acknowledged it, and *"3 of 9 need your attention"* could never reach zero.
An alerting product that ignores you teaches you to ignore it. Volume re-flags
only when it climbs 25% beyond what you already saw.

Every card shows the diff explicitly:

> ₹1,322.00 → ₹1,240.04 · last checked Fri, 3:26 pm IST (4 hr ago)

---

## Honest about what it doesn't know

- Real NSE session awareness. The next session is **named**, not vague — on a
  Friday evening it says *"Opens Monday at 9:15 AM IST"*, skipping the weekend
  and any holiday.
- Per-card data age with proper rollover (`45s`, `12m`, `4h`, `2d`).
- **Feed health.** The "data as of" time is the last time data was actually
  *received*, never the last attempt — the banner used to stay confident while
  every symbol was failing.
- It says whether a stock's volatility is **measured live this session** or
  still **derived from its 3-month history**, rather than presenting both as
  equally settled.

---

## Setup

Requires **Node.js 20.9+**. No API key, no database server, no account.

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npx prisma migrate dev
npm run dev
```

Open <http://localhost:3000>.

`npm install` runs `prisma generate` via `postinstall`. If you change
`prisma/schema.prisma`, re-run `npx prisma migrate dev`.

### Using it

1. Enter any name — no password. The name *is* the account.
2. Search **any NSE stock** by name or symbol; click a result to add it.
3. Click **Mark all as seen** to set your baseline.
4. Click **⚡ simulate event** on any card. NSE is open six hours a day, so
   outside those hours there is genuinely nothing to see — this injects a
   realistic price move, volume spike and headline so the scoring can be
   demonstrated on demand.
5. Watch the card jump to **NOTABLE** or **CRITICAL** with a reason. Click it a
   few times: the presets cycle rather than picking at random and deliberately
   span the range, including volume-only events that reach CRITICAL with no
   price move at all. An earlier set all carried a 1%+ price move and every one
   came out CRITICAL, which hid the fact that the engine discriminates at all.
   Filter with the tabs (All / Needs attention / New / Unchanged).
6. Click **got it** to acknowledge it and return the list to quiet.

`bash demo-setup.sh` arms all of this in one command.

---

## Testing

Seven suites. Two run fully offline:

```bash
npm test      # scoring engine + trading-time/volume signals
```

The rest need `npm run dev` in another terminal:

```bash
npx tsx smoketests/phase1-foundation.ts     # all 40 tickers resolve
npx tsx smoketests/phase2-pipeline.ts       # data pipeline + SSE
npx tsx smoketests/phase4-persistence.ts    # watchlist CRUD + persistence
npx tsx smoketests/phase5-shock-injector.ts # demo overlay + its guards
npx tsx smoketests/phase6-longterm-trend.ts # trend feature
```

Every scoring test pins an **explicit timestamp**. Because the engine measures
trading time, "one hour ago" means something different at 2pm Tuesday than at
2am Sunday — a test reading the wall clock would pass or fail depending on when
it ran.

---

## Architecture

```
Yahoo Finance v8  →  one shared poll loop  →  in-memory quote cache
                                           →  volatility trackers  ─┐
                                           →  volume trackers      ─┤
                                                                    ├→ scoring → tier + reason
SQLite ──→ watchlist + "last seen" snapshot per user ───────────────┘
```

**Live market state is in memory; user state is in SQLite.** The quote cache and
trackers rebuild quickly and are fine to lose on restart. The watchlist and
last-seen snapshots are the state the product's premise depends on surviving a
restart or a return visit days later, so those are persisted.

**One shared polling loop serves every connected browser** — 40 symbols, not
40 × users. It has an in-flight guard so a slow cycle cannot stack, an 8-second
request timeout, exponential backoff on failure, and it drops to a 5-minute
heartbeat when the market is closed (polling at full rate around the clock is
~172,800 requests/day for data that cannot change). Older responses can never
overwrite newer ones, and repeated identical quotes are not learned twice —
recording an untraded stock's unchanged quote as a fresh tick buries real
returns under zeros, understates σ, and makes ordinary moves read as CRITICAL.

**Data source: Yahoo Finance, and nothing else.** There are exactly four
outbound call sites in the codebase, all to `query1.finance.yahoo.com`:

| Module | Endpoint | Used for |
|---|---|---|
| `marketData.ts` | `/v8/finance/chart/<sym>?range=1d` | live quotes (the poll loop) |
| `seedVolatility.ts` | `/v8/finance/chart/<sym>?range=3mo` | deriving σ from real history |
| `longTermTrend.ts` | `/v8/finance/chart/<sym>?range=1y` | the 1M/3M/6M/1Y trend |
| `symbolSearch.ts` | `/v1/finance/search?q=` | NSE symbol search |

Three of those are the same endpoint with a different range. Nothing in the
browser talks to the data source directly — every client call goes to this app's
own `/api/...` routes.

No API key, no auth, no account, which is why setup is four commands and the
deployment needs no secrets.

**That is also a single point of failure, and worth saying plainly.** The
commonly recommended v7 batch endpoint *already broke this way*: it now returns
401 without a session cookie and crumb token, which is why this uses v8 with a
small concurrency cap instead of one batched call. The same could happen to v8.

Two things blunt it, both already built: the poll loop backs off and reports
**feed health** honestly rather than showing stale prices as if they were live,
and every call site is one module behind a narrow interface — swapping providers
means changing `marketData.ts`, not the scoring engine. A proper `QuoteProvider`
abstraction with a fixture implementation for offline tests is the natural next
step and is not built here.

**Any NSE stock can be watched**, not a fixed list. Symbol search hits the
exchange live, a new symbol is validated by whether it returns a real quote, and
the poller tracks the union of everything anyone actually watches (bounded at
250 symbols per process) rather than a hardcoded universe.

That was only possible after removing the reason the list was hardcoded: every
ticker needed a `baseSigma` volatility seed typed in by hand. `seedVolatility.ts`
now derives it from the symbol's own 3-month history. Checked against the
hand-written table, the derived value matched closely for HDFCBANK (0.0134 vs
0.013) and was materially better for volatile names, where the hardcoded figures
had drifted to roughly double the realised value (ADANIENT 0.0196 vs 0.038).

A curated 40-name set survives for two jobs: suggestions in an empty search box,
and an offline fallback seed. It is worth keeping for a third reason — every
ticker in it was verified against the live feed, which caught two that had
changed through real corporate actions (`ZOMATO` → `ETERNAL`,
`TATAMOTORS` → `TMPV`). Both now fail to resolve entirely; a naive list would be
silently broken.

Upstream search alone is not reliable on the names people actually type —
"infosys" returns HCL Infosystems but not INFY — so curated names are matched
locally and listed first, with live results appended.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 ·
Prisma 7 + SQLite via the `better-sqlite3` driver adapter.

---

## Identity, and what it does not protect

There is no password. You type a name, and that name is your watchlist — the
same name on any device brings back the same list.

**This means the watchlist is not private.** Anyone who types your name sees
your list. That is a deliberate trade-off for a demo rather than an oversight,
and the app says so on the sign-in screen instead of leaving you to assume
otherwise. `switch` in the header clears the session.

Real auth is the first thing to add before this saw a real user.

---

## Deploying

**This is a long-running process with a writable database file, not a
serverless app.** On Vercel-style hosts the read-only filesystem breaks SQLite
and cold starts break the polling engine, which *learns* over successive polls —
it would build, load, and do nothing interesting.

Use anything that gives you a container and a persistent volume (Railway,
Render, Fly). A `Dockerfile` and entrypoint are included; the entrypoint runs
migrations, seeds a `demo` account, then serves.

Two environment variables matter:

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | `file:/data/dev.db` | Must point at the mounted volume, or every restart wipes all watchlists |
| `ENABLE_DEMO_SHOCKS` | `true` | ⚡ is **disabled in production by default** — unguarded it is an anonymous public write that pushes a fabricated headline about a real listed company onto every viewer's screen |

---

## Known limitations

Stated plainly, because knowing where a system is weak is part of building it.

- **Single instance only.** The quote cache, volatility trackers and demo
  overlays live in one process; two instances would poll twice, learn different
  volatilities, and disagree about active events. The fix is a shared cache
  (Redis), Postgres, and a dedicated poller worker.
- **Nothing between visits is recorded.** If a stock drops 9% at 10:00 and
  recovers by 14:00, a 15:00 visit sees "quiet". An append-only event log is the
  highest-value next feature — it turns *"what's different"* into *"here's what
  happened."*
- **Volume is not time-of-day normalised.** NSE volume is U-shaped; 2.5× is
  unremarkable at 9:20 and significant at 12:30. The two-poll confirmation is a
  mitigation, not the real fix.
- **Volatility seeds come from 3 months of daily bars.** A shorter window
  reacts faster but is noisier; a stock with a corporate action inside the
  window can produce a distorted seed, so the value is clamped to a plausible
  range. The live-observed estimate takes over after ~10 ticks regardless.
- **Only verified NSE holidays are in the calendar.** A wrong holiday is worse
  than a missing one — it would make the app claim "closed" on a real trading
  day.
- **Index-relative, not sector-relative.** NIFTY 50 and NIFTY Bank are covered;
  a stock is not yet compared against its own sector, so "ITC fell but so did
  all of FMCG" is still invisible.
- **News headlines appear only on simulated events.**
- **One upstream data provider.** See the data-source note above: it is
  unauthenticated and undocumented, and its predecessor endpoint already broke
  once. The app degrades honestly rather than lying about freshness, but it
  cannot fail over.
