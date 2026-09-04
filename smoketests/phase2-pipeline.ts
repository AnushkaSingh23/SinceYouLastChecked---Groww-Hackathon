// Smoke test for Phase 2 — data pipeline (requires `npm run dev` running).
// Run with: npx tsx smoketests/phase2-pipeline.ts

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // First hit starts the poll asynchronously; give it a moment to land.
  await fetch(`${BASE}/api/market-feed`);
  await sleep(2000);

  const res = await fetch(`${BASE}/api/market-feed`);
  check("REST endpoint returns 200", res.ok);
  const body = await res.json();
  check("REST endpoint returns quotes", Array.isArray(body.quotes) && body.quotes.length > 0);
  check("REST endpoint returns a valid market status", ["OPEN", "WEEKEND", "HOLIDAY", "OUTSIDE_HOURS"].includes(body.marketStatus?.reason));
  check("REST endpoint sets lastPollAt", typeof body.lastPollAt === "number");

  // SSE: connect and confirm we get at least one "update" event.
  const controller = new AbortController();
  const streamRes = await fetch(`${BASE}/api/market-feed/stream`, { signal: controller.signal });
  const reader = streamRes.body?.getReader();
  let receivedUpdate = false;

  if (reader) {
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    receivedUpdate = chunk.includes("event: update") && chunk.includes('"quotes"');
  }
  controller.abort();

  check("SSE stream pushes an update event on connect", receivedUpdate);

  console.log(failures === 0 ? "\nAll phase 2 smoke checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed — is `npm run dev` running?", err);
  process.exit(1);
});
