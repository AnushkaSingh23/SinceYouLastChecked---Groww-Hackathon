// Smoke test for Phase 4 — persistence + UI baseline (requires `npm run dev`
// running, since it exercises the real HTTP + DB path).
// Run with: npx tsx smoketests/phase4-persistence.ts

export {}; // force module scope so top-level names don't collide with other smoketest scripts under `tsc`

const BASE = "http://localhost:3000";
let failures = 0;
function check(name: string, condition: boolean) {
  if (condition) console.log(`PASS: ${name}`);
  else {
    console.error(`FAIL: ${name}`);
    failures++;
  }
}

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0];
}

async function main() {
  const handle = `smoketest-${Date.now()}`;

  const identifyRes = await fetch(`${BASE}/api/identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  check("identify creates a user", identifyRes.ok);
  const cookie = extractCookie(identifyRes);
  check("identify sets a session cookie", cookie.length > 0);

  const authHeaders = { Cookie: cookie, "Content-Type": "application/json" };

  // Warm the live feed so RELIANCE.NS has a quote to score against.
  await fetch(`${BASE}/api/market-feed`);
  await new Promise((r) => setTimeout(r, 2000));

  const addRes = await fetch(`${BASE}/api/watchlist`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ symbol: "RELIANCE.NS" }),
  });
  check("adding a symbol succeeds", addRes.ok);

  const listRes = await fetch(`${BASE}/api/watchlist`, { headers: authHeaders });
  const listData = await listRes.json();
  check("watchlist shows the added symbol", listData.items.some((i: { symbol: string }) => i.symbol === "RELIANCE.NS"));

  const freshItem = listData.items.find((i: { symbol: string }) => i.symbol === "RELIANCE.NS");
  check("never-seen item has no z-score", freshItem?.card?.zScore === null);
  // A never-seen item is always tier NEW, full stop — never CRITICAL/
  // NOTABLE, even if it happens to have a real level-break or volume
  // anomaly right now (those are real facts, but have nothing to do with
  // the user's own "since I checked" history — see DECISIONS.md). This
  // used to be a looser assertion tolerating NOTABLE from a live signal;
  // NEW replaces that entirely now.
  check("never-seen item is tier NEW", freshItem?.card?.tier === "NEW");

  const markSeenRes = await fetch(`${BASE}/api/watchlist/mark-seen`, {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  });
  check("mark-seen succeeds", markSeenRes.ok);

  const afterSeenRes = await fetch(`${BASE}/api/watchlist`, { headers: authHeaders });
  const afterSeenData = await afterSeenRes.json();
  const afterSeenItem = afterSeenData.items.find((i: { symbol: string }) => i.symbol === "RELIANCE.NS");
  // The invariant mark-seen actually guarantees is the PRICE baseline reset
  // (change% and z-score collapse to ~0) — not the overall tier, since a
  // real, independent volume anomaly can still be active right now
  // regardless of when the price was last checked (see note above).
  check("after mark-seen, price change collapses to ~0%", Math.abs(afterSeenItem?.card?.priceChangePct ?? 1) < 0.001);
  check("after mark-seen, z-score collapses to ~0", (afterSeenItem?.card?.zScore ?? 999) < 0.1);
  check("after mark-seen, lastSeenAt is now set", afterSeenItem?.lastSeenAt !== null);

  const removeRes = await fetch(`${BASE}/api/watchlist?symbol=RELIANCE.NS`, { method: "DELETE", headers: authHeaders });
  check("removing a symbol succeeds", removeRes.ok);

  const afterRemoveRes = await fetch(`${BASE}/api/watchlist`, { headers: authHeaders });
  const afterRemoveData = await afterRemoveRes.json();
  check("watchlist is empty after removal", afterRemoveData.items.length === 0);

  console.log(failures === 0 ? "\nAll phase 4 smoke checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed — is `npm run dev` running?", err);
  process.exit(1);
});
