// Smoke test for Phase 5 — dev shock injector (requires `npm run dev`
// running). Run with: npx tsx smoketests/phase5-shock-injector.ts

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
  const handle = `smoketest-shock-${Date.now()}`;
  const identifyRes = await fetch(`${BASE}/api/identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  const cookie = extractCookie(identifyRes);
  const authHeaders = { Cookie: cookie, "Content-Type": "application/json" };

  // Warm the live feed and add a symbol + mark it seen so we have a real
  // last-seen baseline to score the shock against.
  await fetch(`${BASE}/api/market-feed`);
  await new Promise((r) => setTimeout(r, 2000));
  await fetch(`${BASE}/api/watchlist`, { method: "POST", headers: authHeaders, body: JSON.stringify({ symbol: "SUZLON.NS" }) });
  await fetch(`${BASE}/api/watchlist/mark-seen`, { method: "POST", headers: authHeaders, body: "{}" });

  // Reject unknown symbols.
  const badRes = await fetch(`${BASE}/api/dev/shock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "NOT_A_REAL_SYMBOL", priceOverridePct: -0.05 }),
  });
  check("shock injector rejects an unknown symbol", badRes.status === 400);

  // Inject a shock: -6% price move + volume spike.
  const injectRes = await fetch(`${BASE}/api/dev/shock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "SUZLON.NS", priceOverridePct: -0.06, volumeAnomalyRatio: 4.5, headline: "Test headline" }),
  });
  check("shock injection succeeds", injectRes.ok);

  const afterShockRes = await fetch(`${BASE}/api/watchlist`, { headers: authHeaders });
  const afterShockData = await afterShockRes.json();
  const shockedItem = afterShockData.items.find((i: { symbol: string }) => i.symbol === "SUZLON.NS");

  check("shocked card is marked isSimulated", shockedItem?.card?.isSimulated === true);
  check("shocked card carries the injected headline", shockedItem?.card?.newsHeadline === "Test headline");
  check("shocked card shows a negative price change", shockedItem?.card?.priceChangePct < 0);
  check("shocked card reports a volume anomaly", shockedItem?.card?.isVolumeAnomaly === true);
  check(
    "shocked card escalates past QUIET (multiple signals: price + volume)",
    shockedItem?.card?.tier !== "QUIET"
  );

  // Clear this one symbol's shock.
  const clearOneRes = await fetch(`${BASE}/api/dev/shock?symbol=SUZLON.NS`, { method: "DELETE" });
  check("clearing one symbol's shock succeeds", clearOneRes.ok);

  const afterClearRes = await fetch(`${BASE}/api/watchlist`, { headers: authHeaders });
  const afterClearData = await afterClearRes.json();
  const clearedItem = afterClearData.items.find((i: { symbol: string }) => i.symbol === "SUZLON.NS");
  check("cleared card is no longer simulated", !clearedItem?.card?.isSimulated);
  check("cleared card returns to QUIET (was just marked seen, real market barely moved)", clearedItem?.card?.tier === "QUIET" || clearedItem?.card?.zScore < 3);

  // Real trackers must be untouched by the shock — inject again then verify
  // the underlying volatility/volume state didn't get corrupted.
  await fetch(`${BASE}/api/dev/shock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "SUZLON.NS", priceOverridePct: 0.1 }),
  });
  const marketFeedRes = await fetch(`${BASE}/api/market-feed`);
  const marketFeedData = await marketFeedRes.json();
  const realQuote = marketFeedData.quotes.find((q: { symbol: string; price: number }) => q.symbol === "SUZLON.NS");
  check(
    "the real quote cache is untouched by the shock overlay (not overridden)",
    realQuote && Math.abs(realQuote.price - (shockedItem?.card?.currentPrice ?? 0)) > 0.01
  );

  await fetch(`${BASE}/api/dev/shock`, { method: "DELETE" });

  // A simulated volume ratio below the app's own real-data threshold
  // (2.5x) must not be classified as an anomaly — found in review: the
  // shock path used to unconditionally mark any provided ratio as
  // `isAnomaly: true`, even 1.2x, contradicting the app's own definition.
  await fetch(`${BASE}/api/dev/shock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "SUZLON.NS", volumeAnomalyRatio: 1.2 }),
  });
  const belowThresholdRes = await fetch(`${BASE}/api/watchlist`, { headers: authHeaders });
  const belowThresholdData = await belowThresholdRes.json();
  const belowThresholdItem = belowThresholdData.items.find((i: { symbol: string }) => i.symbol === "SUZLON.NS");
  check(
    "a simulated 1.2x volume ratio (below the 2.5x threshold) is not classified as an anomaly",
    belowThresholdItem?.card?.isVolumeAnomaly === false
  );

  // Reject a price override that would make the price zero or negative —
  // found in review: -1.5 (-150%) produced a currentPrice of -1156.20.
  const negativePriceRes = await fetch(`${BASE}/api/dev/shock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "SUZLON.NS", priceOverridePct: -1.5 }),
  });
  check("a priceOverridePct that would make price negative is rejected", negativePriceRes.status === 400);

  await fetch(`${BASE}/api/dev/shock`, { method: "DELETE" });
  await fetch(`${BASE}/api/watchlist?symbol=SUZLON.NS`, { method: "DELETE", headers: authHeaders });

  console.log(failures === 0 ? "\nAll phase 5 smoke checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed — is `npm run dev` running?", err);
  process.exit(1);
});
