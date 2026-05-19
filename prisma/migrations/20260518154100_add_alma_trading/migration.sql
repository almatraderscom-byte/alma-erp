DO $$
BEGIN
  CREATE TYPE "TradingAccountStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "TradingAccountType" AS ENUM ('BINANCE_P2P', 'MERCHANT', 'STAFF_OPERATED', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "TradingCapitalEntryType" AS ENUM ('DEPOSIT', 'WITHDRAW', 'ADJUSTMENT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "TradingAccount" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "assignedUserId" TEXT,
  "accountTitle" TEXT NOT NULL,
  "binanceUid" TEXT,
  "accountType" "TradingAccountType" NOT NULL DEFAULT 'BINANCE_P2P',
  "status" "TradingAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "startingCapital" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "currentBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "totalProfit" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "totalLoss" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "totalFees" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "merchantTarget" DECIMAL(14,2),
  "merchantProgress" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "startDate" TIMESTAMP(3) NOT NULL,
  "completedDate" TIMESTAMP(3),
  "notes" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TradingTrade" (
  "id" TEXT NOT NULL,
  "tradingAccountId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "buyAmount" DECIMAL(14,2) NOT NULL,
  "sellAmount" DECIMAL(14,2) NOT NULL,
  "feeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "netProfit" DECIMAL(14,2) NOT NULL,
  "tradeDate" TIMESTAMP(3) NOT NULL,
  "notes" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingTrade_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TradingExpense" (
  "id" TEXT NOT NULL,
  "tradingAccountId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "expenseType" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "notes" TEXT,
  "attachmentUrl" TEXT,
  "expenseDate" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingExpense_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TradingCapitalEntry" (
  "id" TEXT NOT NULL,
  "tradingAccountId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "entryType" "TradingCapitalEntryType" NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "notes" TEXT,
  "createdBy" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingCapitalEntry_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "TradingAccount"
    ADD CONSTRAINT "TradingAccount_assignedUserId_fkey"
    FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "TradingTrade"
    ADD CONSTRAINT "TradingTrade_tradingAccountId_fkey"
    FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "TradingTrade"
    ADD CONSTRAINT "TradingTrade_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "TradingExpense"
    ADD CONSTRAINT "TradingExpense_tradingAccountId_fkey"
    FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "TradingExpense"
    ADD CONSTRAINT "TradingExpense_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "TradingCapitalEntry"
    ADD CONSTRAINT "TradingCapitalEntry_tradingAccountId_fkey"
    FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "TradingCapitalEntry"
    ADD CONSTRAINT "TradingCapitalEntry_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "TradingAccount_businessId_status_idx" ON "TradingAccount"("businessId", "status");
CREATE INDEX IF NOT EXISTS "TradingAccount_businessId_assignedUserId_idx" ON "TradingAccount"("businessId", "assignedUserId");
CREATE INDEX IF NOT EXISTS "TradingAccount_businessId_deletedAt_createdAt_idx" ON "TradingAccount"("businessId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingAccount_businessId_binanceUid_idx" ON "TradingAccount"("businessId", "binanceUid");
CREATE INDEX IF NOT EXISTS "TradingAccount_assignedUserId_idx" ON "TradingAccount"("assignedUserId");
CREATE INDEX IF NOT EXISTS "TradingAccount_status_startDate_idx" ON "TradingAccount"("status", "startDate");

CREATE INDEX IF NOT EXISTS "TradingTrade_businessId_tradeDate_idx" ON "TradingTrade"("businessId", "tradeDate");
CREATE INDEX IF NOT EXISTS "TradingTrade_businessId_userId_tradeDate_idx" ON "TradingTrade"("businessId", "userId", "tradeDate");
CREATE INDEX IF NOT EXISTS "TradingTrade_tradingAccountId_tradeDate_idx" ON "TradingTrade"("tradingAccountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "TradingTrade_tradingAccountId_deletedAt_createdAt_idx" ON "TradingTrade"("tradingAccountId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingTrade_userId_idx" ON "TradingTrade"("userId");

CREATE INDEX IF NOT EXISTS "TradingExpense_businessId_expenseDate_idx" ON "TradingExpense"("businessId", "expenseDate");
CREATE INDEX IF NOT EXISTS "TradingExpense_businessId_expenseType_idx" ON "TradingExpense"("businessId", "expenseType");
CREATE INDEX IF NOT EXISTS "TradingExpense_tradingAccountId_expenseDate_idx" ON "TradingExpense"("tradingAccountId", "expenseDate");
CREATE INDEX IF NOT EXISTS "TradingExpense_tradingAccountId_deletedAt_createdAt_idx" ON "TradingExpense"("tradingAccountId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingExpense_createdBy_idx" ON "TradingExpense"("createdBy");

CREATE INDEX IF NOT EXISTS "TradingCapitalEntry_businessId_entryType_createdAt_idx" ON "TradingCapitalEntry"("businessId", "entryType", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingCapitalEntry_tradingAccountId_createdAt_idx" ON "TradingCapitalEntry"("tradingAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingCapitalEntry_tradingAccountId_deletedAt_createdAt_idx" ON "TradingCapitalEntry"("tradingAccountId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingCapitalEntry_createdBy_idx" ON "TradingCapitalEntry"("createdBy");
