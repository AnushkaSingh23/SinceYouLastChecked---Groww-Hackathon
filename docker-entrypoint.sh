#!/usr/bin/env sh
# Boot order: migrate -> seed -> serve.
set -e

echo "[boot] DATABASE_URL=${DATABASE_URL}"

# `migrate deploy` (not `migrate dev`) is the production command: it applies
# committed migrations and never generates or resets anything.
echo "[boot] applying migrations"
npx prisma migrate deploy

# Best-effort: gives a demo visitor a populated watchlist instead of a blank
# screen. Never fatal — see scripts/seed-demo.ts.
echo "[boot] seeding demo account"
npx tsx scripts/seed-demo.ts || echo "[boot] seed skipped"

echo "[boot] starting server on :${PORT:-3000}"
exec npm run start -- --port "${PORT:-3000}" --hostname 0.0.0.0
