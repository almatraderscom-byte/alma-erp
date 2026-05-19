DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TradingTradeType') THEN
    CREATE TYPE "TradingTradeType" AS ENUM ('BUY', 'SELL');
  END IF;
END $$;

ALTER TABLE "TradingAccount"
  ADD COLUMN IF NOT EXISTS "totalBuyUsdt" DECIMAL(18, 8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalSellUsdt" DECIMAL(18, 8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalBuyBdt" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalSellBdt" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usdtBalance" DECIMAL(18, 8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "inventoryCostBdt" DECIMAL(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE "TradingTrade"
  ADD COLUMN IF NOT EXISTS "tradeType" "TradingTradeType" NOT NULL DEFAULT 'SELL',
  ADD COLUMN IF NOT EXISTS "bdtRate" DECIMAL(12, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalBdt" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "netBdt" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "costBasisBdt" DECIMAL(14, 2) NOT NULL DEFAULT 0;

UPDATE "TradingTrade"
SET
  "bdtRate" = CASE
    WHEN "bdtRate" = 0 AND "sellRateBdt" > 0 THEN "sellRateBdt"
    WHEN "bdtRate" = 0 THEN "buyRateBdt"
    ELSE "bdtRate"
  END,
  "totalBdt" = CASE
    WHEN "totalBdt" = 0 AND "sellAmount" > 0 THEN "sellAmount"
    WHEN "totalBdt" = 0 THEN "buyAmount"
    ELSE "totalBdt"
  END,
  "netBdt" = CASE
    WHEN "netBdt" = 0 AND "sellAmount" > 0 THEN "sellAmount" - COALESCE("feeBdt", "feeAmount", 0)
    WHEN "netBdt" = 0 THEN "buyAmount" + COALESCE("feeBdt", "feeAmount", 0)
    ELSE "netBdt"
  END,
  "costBasisBdt" = CASE
    WHEN "costBasisBdt" = 0 THEN "buyAmount"
    ELSE "costBasisBdt"
  END;

ALTER TABLE "TradingDailySnapshot"
  ADD COLUMN IF NOT EXISTS "buyUsdtVolume" DECIMAL(18, 8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sellUsdtVolume" DECIMAL(18, 8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "buyBdtVolume" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sellBdtVolume" DECIMAL(14, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "TradingAccount_businessId_usdtBalance_idx"
  ON "TradingAccount"("businessId", "usdtBalance");

CREATE INDEX IF NOT EXISTS "TradingTrade_businessId_tradeType_tradeDate_idx"
  ON "TradingTrade"("businessId", "tradeType", "tradeDate");

CREATE INDEX IF NOT EXISTS "TradingTrade_tradingAccountId_tradeType_tradeDate_idx"
  ON "TradingTrade"("tradingAccountId", "tradeType", "tradeDate");
