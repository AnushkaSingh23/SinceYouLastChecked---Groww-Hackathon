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
  check("never-seen item is QUIET, not a false CRITICAL", freshItem?.card?.tier === "QUIET");

  const markSeenRes = await fetch(`${BASE}/api/watchlist/mark-seen`, {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  });
  check("mark-seen succeeds", markSeenRes.ok);

  const afterSeenRes = await fetch(`${BASE}/api/watchlist`, { headers: authHeaders });
  const afterSeenData = await afterSeenRes.json();
  const afterSeenItem = afterSeenData.items.find((i: { symbol: string }) => i.symbol === "RELIANCE.NS");
  check("after mark-seen, tier resets to QUIET with ~0 change", afterSeenItem?.card?.tier === "QUIET");
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
