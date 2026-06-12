-- Trading account 50/50 partnership settlement layer

DO $$
BEGIN
  CREATE TYPE "TradingExpensePaidBy" AS ENUM ('OWNER', 'STAFF');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "TradingAccount"
  ADD COLUMN IF NOT EXISTS "partnershipEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "staffSharePercent" DECIMAL(8,4) NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "lastPartnershipSettledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "partnershipBaselineProfit" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "partnershipBaselineLoss" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "partnershipBaselineOwnerExpenses" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "partnershipBaselineStaffExpenses" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "TradingExpense"
  ADD COLUMN IF NOT EXISTS "paidBy" "TradingExpensePaidBy",
  ADD COLUMN IF NOT EXISTS "settlementId" TEXT;

CREATE TABLE IF NOT EXISTS "TradingPartnershipSettlement" (
    "id" TEXT NOT NULL,
    "tradingAccountId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "deltaProfitBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deltaLossBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netTradingDeltaBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "ownerPaidExpensesBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "staffPaidExpensesBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "staffSharePercent" DECIMAL(8,4) NOT NULL DEFAULT 50,
    "staffTradingShareBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "expenseAdjustmentBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netStaffOwesBdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "adminOverrideBdt" DECIMAL(14,2),
    "notes" TEXT,
    "settledByUserId" TEXT NOT NULL,
    "ledgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingPartnershipSettlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TradingPartnershipSettlement_tradingAccountId_createdAt_idx" ON "TradingPartnershipSettlement"("tradingAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingPartnershipSettlement_businessId_createdAt_idx" ON "TradingPartnershipSettlement"("businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingPartnershipSettlement_settledByUserId_idx" ON "TradingPartnershipSettlement"("settledByUserId");
CREATE INDEX IF NOT EXISTS "TradingExpense_settlementId_idx" ON "TradingExpense"("settlementId");

DO $$
BEGIN
  ALTER TABLE "TradingExpense" ADD CONSTRAINT "TradingExpense_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "TradingPartnershipSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "TradingPartnershipSettlement" ADD CONSTRAINT "TradingPartnershipSettlement_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "TradingPartnershipSettlement" ADD CONSTRAINT "TradingPartnershipSettlement_settledByUserId_fkey" FOREIGN KEY ("settledByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
