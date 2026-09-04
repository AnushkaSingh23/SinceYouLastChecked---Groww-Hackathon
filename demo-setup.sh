#!/usr/bin/env bash
# Arms the demo: signs in, ensures a watchlist, sets the "seen" baseline, then
# injects two simulated events so the list has something to show.
#
# Simulated events expire after 10 minutes by design (so a demo can't get stuck
# in a fake state), so re-run this right before recording or screenshotting.
#
#   bash demo-setup.sh              # defaults to handle "anushka" on :3000
#   bash demo-setup.sh myname 3000
#
# Not part of the app — a local convenience script, gitignored.

set -euo pipefail

HANDLE="${1:-anushka}"
PORT="${2:-3000}"
BASE="http://localhost:${PORT}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

say() { printf '  %s\n' "$*"; }

printf '\nArming demo at %s as "%s"\n\n' "$BASE" "$HANDLE"

if ! curl -sf -o /dev/null "$BASE" 2>/dev/null; then
  echo "  ERROR: nothing responding at $BASE — start it with: npm run dev" >&2
  exit 1
fi

say "warming the live feed (needs ~25s for volume baselines)..."
curl -s -o /dev/null "$BASE/api/market-feed"
sleep 25

say "signing in"
curl -s -c "$JAR" -X POST "$BASE/api/identity" \
  -H "Content-Type: application/json" -d "{\"handle\":\"$HANDLE\"}" > /dev/null

say "adding stocks"
for s in RELIANCE.NS HDFCBANK.NS TCS.NS INFY.NS BAJFINANCE.NS ITC.NS; do
  curl -s -b "$JAR" -X POST "$BASE/api/watchlist" \
    -H "Content-Type: application/json" -d "{\"symbol\":\"$s\"}" > /dev/null
done

# Must happen BEFORE mark-seen. "Mark as seen" deliberately records the price
# that was on screen, which includes any active simulated event — so if a shock
# from a previous run is still inside its 10-minute TTL, the baseline gets set
# to the shocked price and the freshly injected event then shows a 0.00% diff.
# Clearing first makes this script safe to re-run back to back.
say "clearing any simulated events left over from a previous run"
curl -s -b "$JAR" -X DELETE "$BASE/api/dev/shock" > /dev/null

say "setting the seen baseline (list goes quiet)"
curl -s -b "$JAR" -X POST "$BASE/api/watchlist/mark-seen" \
  -H "Content-Type: application/json" -d '{}' > /dev/null

# Removed first, then re-added AFTER mark-seen. Removing cascades away its
# last-seen snapshot, so it comes back with genuinely no baseline — which is
# what puts it in the NEW tier. A plain re-add would be a no-op upsert and
# would keep whatever baseline the stock already had from a previous run.
say "re-adding one stock with no baseline, to show the NEW tier"
curl -s -b "$JAR" -X DELETE "$BASE/api/watchlist?symbol=ADANIENT.NS" > /dev/null
curl -s -b "$JAR" -X POST "$BASE/api/watchlist" \
  -H "Content-Type: application/json" -d '{"symbol":"ADANIENT.NS"}' > /dev/null

say "injecting a price-driven event (Reliance)"
curl -s -b "$JAR" -X POST "$BASE/api/dev/shock" -H "Content-Type: application/json" \
  -d '{"symbol":"RELIANCE.NS","priceOverridePct":-0.062,"volumeAnomalyRatio":4.1,"headline":"Q2 earnings miss street estimates by 9%"}' > /dev/null

say "injecting a volume-driven event (HDFC Bank)"
curl -s -b "$JAR" -X POST "$BASE/api/dev/shock" -H "Content-Type: application/json" \
  -d '{"symbol":"HDFCBANK.NS","priceOverridePct":0.012,"volumeAnomalyRatio":5.3,"headline":"Unusual volume ahead of scheduled board meeting"}' > /dev/null

cat <<EOF

Ready. Open $BASE and sign in as "$HANDLE".

  Expect: 2 CRITICAL (one price-driven, one volume-driven), 1 NEW, rest quiet.
  The simulated events expire in 10 minutes — re-run this to re-arm.

EOF
