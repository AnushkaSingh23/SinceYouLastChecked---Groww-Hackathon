-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LastSeenSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "watchlistItemId" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL,
    CONSTRAINT "LastSeenSnapshot_watchlistItemId_fkey" FOREIGN KEY ("watchlistItemId") REFERENCES "WatchlistItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LastSeenSnapshot" ("id", "price", "timestamp", "watchlistItemId") SELECT "id", "price", "timestamp", "watchlistItemId" FROM "LastSeenSnapshot";
DROP TABLE "LastSeenSnapshot";
ALTER TABLE "new_LastSeenSnapshot" RENAME TO "LastSeenSnapshot";
CREATE UNIQUE INDEX "LastSeenSnapshot_watchlistItemId_key" ON "LastSeenSnapshot"("watchlistItemId");
CREATE TABLE "new_WatchlistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WatchlistItem" ("addedAt", "id", "symbol", "userId") SELECT "addedAt", "id", "symbol", "userId" FROM "WatchlistItem";
DROP TABLE "WatchlistItem";
ALTER TABLE "new_WatchlistItem" RENAME TO "WatchlistItem";
CREATE UNIQUE INDEX "WatchlistItem_userId_symbol_key" ON "WatchlistItem"("userId", "symbol");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
