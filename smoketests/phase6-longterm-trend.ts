// Smoke test for Phase 6 — longer-term trend feature (requires `npm run
// dev` running). Run with: npx tsx smoketests/phase6-longterm-trend.ts

export {};

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
  const handle = `smoketest-trend-${Date.now()}`;
  const identifyRes = await fetch(`${BASE}/api/identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  const cookie = extractCookie(identifyRes);
  const authHeaders = { Cookie: cookie, "Content-Type": "application/json" };

  await fetch(`${BASE}/api/market-feed`);
  await new Promise((r) => setTimeout(r, 2000));
  await fetch(`${BASE}/api/watchlist`, { method: "POST", headers: authHeaders, body: JSON.stringify({ symbol: "RELIANCE.NS" }) });

  const res = await fetch(`${BASE}/api/watchlist`, { headers: authHeaders });
  const data = await res.json();
  const item = data.items.find((i: { symbol: string }) => i.symbol === "RELIANCE.NS");

  check("watchlist item includes a trend field", item?.trend !== undefined);
  check("trend has a 1-month figure", typeof item?.trend?.oneMonthPct === "number");
  check("trend has a 3-month figure", typeof item?.trend?.threeMonthPct === "number");
  check("trend has a 6-month figure", typeof item?.trend?.sixMonthPct === "number");
  check("trend has a 1-year figure", typeof item?.trend?.oneYearPct === "number");
  check(
    "trend label is one of the three valid values",
    ["Upward", "Downward", "Mixed"].includes(item?.trend?.label)
  );

  // Card and priceChangeAbs (the ₹-amount fix, replacing the old sigma
  // bracket) are present alongside trend — the primary feature stays intact.
  check("card still has priceChangeAbs (the rupee-amount fix)", typeof item?.card?.priceChangeAbs === "number");

  // A second request should be fast — the cache is doing its job, not
  // refetching a year of history from Yahoo every single request.
  const start = Date.now();
  await fetch(`${BASE}/api/watchlist`, { headers: authHeaders });
  const elapsed = Date.now() - start;
  check(`repeat request is fast (cached, took ${elapsed}ms)`, elapsed < 2000);

  await fetch(`${BASE}/api/watchlist?symbol=RELIANCE.NS`, { method: "DELETE", headers: authHeaders });

  console.log(failures === 0 ? "\nAll phase 6 smoke checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed — is `npm run dev` running?", err);
  process.exit(1);
});
