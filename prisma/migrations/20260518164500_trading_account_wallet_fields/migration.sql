ALTER TABLE "TradingAccount"
  ADD COLUMN IF NOT EXISTS "totalExpenses" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalWithdrawals" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "netRoi" DECIMAL(8, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "TradingAccount_businessId_currentBalance_idx"
  ON "TradingAccount"("businessId", "currentBalance");

CREATE INDEX IF NOT EXISTS "TradingAccount_businessId_netRoi_idx"
  ON "TradingAccount"("businessId", "netRoi");
