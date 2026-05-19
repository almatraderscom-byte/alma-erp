DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TradingCommissionType') THEN
    CREATE TYPE "TradingCommissionType" AS ENUM ('NONE', 'PERCENTAGE', 'FIXED');
  END IF;
END $$;

ALTER TABLE "TradingAccount"
  ADD COLUMN IF NOT EXISTS "commissionType" "TradingCommissionType" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "commissionRate" DECIMAL(8, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fixedCommission" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "completionBonus" DECIMAL(12, 2) NOT NULL DEFAULT 0;
