// Prisma 7 requires a driver adapter — passing a bare connection string to
// PrismaClient no longer works. Singleton guarded on globalThis so Next.js
// dev-mode hot-reload doesn't open a new SQLite connection on every save
// (same pattern as marketFeedStore.ts).

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

declare global {
   
  var __prisma: PrismaClient | undefined;
}

function createClient() {
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "file:./dev.db" });
  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__prisma ?? createClient();
globalThis.__prisma = prisma;
