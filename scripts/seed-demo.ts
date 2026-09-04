// Seeds a `demo` account with a starter watchlist, so a deployed demo link
// doesn't drop a first-time visitor onto an empty screen.
//
// Deliberately seeds the watchlist but NOT a last-seen baseline. A baseline is
// a record of what a real person actually looked at; inventing one would mean
// fabricating a "since you last checked" diff that never happened, and this
// app's whole argument is that its numbers are honest. So the six stocks land
// in the NEW tier — which is itself the correct, demonstrable behaviour — and
// the visitor sets a real baseline with one click on "Mark all as seen".
//
// Idempotent: safe to run on every boot.

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";

const DEMO_HANDLE = process.env.DEMO_HANDLE ?? "demo";
const DEMO_SYMBOLS = [
  "RELIANCE.NS",
  "HDFCBANK.NS",
  "TCS.NS",
  "INFY.NS",
  "BAJFINANCE.NS",
  "ADANIENT.NS",
];

async function main() {
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "file:./dev.db" });
  const prisma = new PrismaClient({ adapter });

  try {
    const user = await prisma.user.upsert({
      where: { handle: DEMO_HANDLE },
      update: {},
      create: { handle: DEMO_HANDLE },
    });

    for (const symbol of DEMO_SYMBOLS) {
      await prisma.watchlistItem.upsert({
        where: { userId_symbol: { userId: user.id, symbol } },
        update: {},
        create: { userId: user.id, symbol },
      });
    }

    const count = await prisma.watchlistItem.count({ where: { userId: user.id } });
    console.log(`[seed] "${DEMO_HANDLE}" ready with ${count} stocks`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // A failed seed must not stop the server from starting — an app with an
  // empty demo account is far better than an app that won't boot.
  console.error("[seed] failed (continuing anyway):", err);
  process.exit(0);
});
