CREATE TABLE IF NOT EXISTS "TradingBkashDailySummary" (
  "id" TEXT NOT NULL,
  "tradingAccountId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "summaryDate" TIMESTAMP(3) NOT NULL,
  "totalOrders" INTEGER NOT NULL DEFAULT 0,
  "totalProfitBdt" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "totalLossBdt" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "netResultBdt" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdBy" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingBkashDailySummary_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TradingPerformanceScreenshot" (
  "id" TEXT NOT NULL,
  "tradingAccountId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "shotDate" TIMESTAMP(3) NOT NULL,
  "bucket" TEXT NOT NULL,
  "objectPath" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "note" TEXT,
  "archivedAt" TIMESTAMP(3),
  "uploadedBy" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingPerformanceScreenshot_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TradingBkashDailySummary_tradingAccountId_fkey'
  ) THEN
    ALTER TABLE "TradingBkashDailySummary"
      ADD CONSTRAINT "TradingBkashDailySummary_tradingAccountId_fkey"
      FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TradingBkashDailySummary_createdBy_fkey'
  ) THEN
    ALTER TABLE "TradingBkashDailySummary"
      ADD CONSTRAINT "TradingBkashDailySummary_createdBy_fkey"
      FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TradingPerformanceScreenshot_tradingAccountId_fkey'
  ) THEN
    ALTER TABLE "TradingPerformanceScreenshot"
      ADD CONSTRAINT "TradingPerformanceScreenshot_tradingAccountId_fkey"
      FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TradingPerformanceScreenshot_uploadedBy_fkey'
  ) THEN
    ALTER TABLE "TradingPerformanceScreenshot"
      ADD CONSTRAINT "TradingPerformanceScreenshot_uploadedBy_fkey"
      FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "TradingBkashDailySummary_tradingAccountId_summaryDate_key"
  ON "TradingBkashDailySummary"("tradingAccountId", "summaryDate");
CREATE INDEX IF NOT EXISTS "TradingBkashDailySummary_businessId_summaryDate_idx"
  ON "TradingBkashDailySummary"("businessId", "summaryDate");
CREATE INDEX IF NOT EXISTS "TradingBkashDailySummary_businessId_tradingAccountId_summaryDate_idx"
  ON "TradingBkashDailySummary"("businessId", "tradingAccountId", "summaryDate");
CREATE INDEX IF NOT EXISTS "TradingBkashDailySummary_tradingAccountId_deletedAt_summaryDate_idx"
  ON "TradingBkashDailySummary"("tradingAccountId", "deletedAt", "summaryDate");
CREATE INDEX IF NOT EXISTS "TradingBkashDailySummary_createdBy_idx"
  ON "TradingBkashDailySummary"("createdBy");

CREATE INDEX IF NOT EXISTS "TradingPerformanceScreenshot_businessId_shotDate_idx"
  ON "TradingPerformanceScreenshot"("businessId", "shotDate");
CREATE INDEX IF NOT EXISTS "TradingPerformanceScreenshot_businessId_tradingAccountId_shotDate_idx"
  ON "TradingPerformanceScreenshot"("businessId", "tradingAccountId", "shotDate");
CREATE INDEX IF NOT EXISTS "TradingPerformanceScreenshot_tradingAccountId_archivedAt_shotDate_idx"
  ON "TradingPerformanceScreenshot"("tradingAccountId", "archivedAt", "shotDate");
CREATE INDEX IF NOT EXISTS "TradingPerformanceScreenshot_tradingAccountId_deletedAt_shotDate_idx"
  ON "TradingPerformanceScreenshot"("tradingAccountId", "deletedAt", "shotDate");
CREATE INDEX IF NOT EXISTS "TradingPerformanceScreenshot_uploadedBy_idx"
  ON "TradingPerformanceScreenshot"("uploadedBy");
