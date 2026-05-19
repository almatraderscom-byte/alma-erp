ALTER TABLE "TradingTrade"
  ADD COLUMN IF NOT EXISTS "usdtAmount" DECIMAL(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "buyRateBdt" DECIMAL(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sellRateBdt" DECIMAL(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "feeUsdt" DECIMAL(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "feeBdt" DECIMAL(14,2) NOT NULL DEFAULT 0;

UPDATE "TradingTrade"
SET "feeBdt" = "feeAmount"
WHERE "feeBdt" = 0 AND "feeAmount" <> 0;

CREATE TABLE IF NOT EXISTS "TradingDailySnapshot" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "tradingAccountId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "tradeCount" INTEGER NOT NULL DEFAULT 0,
  "usdtVolume" DECIMAL(18,8) NOT NULL DEFAULT 0,
  "grossProfitBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "grossLossBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "feeBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "expenseBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "netResultBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "balanceSnapshot" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingDailySnapshot_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "TradingDailySnapshot"
    ADD CONSTRAINT "TradingDailySnapshot_tradingAccountId_fkey"
    FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "TradingDailySnapshot_tradingAccountId_date_key" ON "TradingDailySnapshot"("tradingAccountId", "date");
CREATE INDEX IF NOT EXISTS "TradingTrade_businessId_tradingAccountId_tradeDate_idx" ON "TradingTrade"("businessId", "tradingAccountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "TradingDailySnapshot_businessId_date_idx" ON "TradingDailySnapshot"("businessId", "date");
CREATE INDEX IF NOT EXISTS "TradingDailySnapshot_businessId_tradingAccountId_date_idx" ON "TradingDailySnapshot"("businessId", "tradingAccountId", "date");
CREATE INDEX IF NOT EXISTS "TradingDailySnapshot_tradingAccountId_date_idx" ON "TradingDailySnapshot"("tradingAccountId", "date");
