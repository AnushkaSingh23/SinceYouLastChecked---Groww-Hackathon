-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LastSeenSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "watchlistItemId" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "levelBreak" BOOLEAN NOT NULL DEFAULT false,
    "volumeRatio" REAL,
    CONSTRAINT "LastSeenSnapshot_watchlistItemId_fkey" FOREIGN KEY ("watchlistItemId") REFERENCES "WatchlistItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LastSeenSnapshot" ("id", "price", "timestamp", "watchlistItemId") SELECT "id", "price", "timestamp", "watchlistItemId" FROM "LastSeenSnapshot";
DROP TABLE "LastSeenSnapshot";
ALTER TABLE "new_LastSeenSnapshot" RENAME TO "LastSeenSnapshot";
CREATE UNIQUE INDEX "LastSeenSnapshot_watchlistItemId_key" ON "LastSeenSnapshot"("watchlistItemId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
