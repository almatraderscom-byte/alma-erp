-- Trading daily volume targets + penalties (Super Admin controlled)

CREATE TYPE "TradingVolumeTargetStatus" AS ENUM ('PENDING', 'MET', 'MISSED', 'IGNORED');
CREATE TYPE "TradingVolumeTargetPenaltyStatus" AS ENUM ('PENDING', 'APPLIED', 'PARTIALLY_WAIVED', 'WAIVED', 'REJECTED');

CREATE TABLE "TradingDailyVolumeTarget" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "tradingAccountId" TEXT NOT NULL,
  "targetDate" TIMESTAMP(3) NOT NULL,
  "targetUsdt" DECIMAL(18,8) NOT NULL,
  "actualUsdt" DECIMAL(18,8) NOT NULL DEFAULT 0,
  "status" "TradingVolumeTargetStatus" NOT NULL DEFAULT 'PENDING',
  "penaltyAmountBdt" DECIMAL(12,2),
  "setById" TEXT NOT NULL,
  "notes" TEXT,
  "ignoredById" TEXT,
  "ignoredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TradingDailyVolumeTarget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TradingVolumeTargetPenalty" (
  "id" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "userId" TEXT,
  "status" "TradingVolumeTargetPenaltyStatus" NOT NULL DEFAULT 'PENDING',
  "originalAmountBdt" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "appliedAmountBdt" DECIMAL(12,2),
  "waivedAmountBdt" DECIMAL(12,2),
  "penaltyLedgerEntryId" TEXT,
  "reversalLedgerEntryId" TEXT,
  "appliedById" TEXT,
  "waivedById" TEXT,
  "adminNote" TEXT,
  "appliedAt" TIMESTAMP(3),
  "waivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TradingVolumeTargetPenalty_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TradingVolumeTargetAudit" (
  "id" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actorUserId" TEXT,
  "detail" TEXT,
  "metadataJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingVolumeTargetAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TradingVolumeTargetSettings" (
  "businessId" TEXT NOT NULL,
  "autoPenaltyEnabled" BOOLEAN NOT NULL DEFAULT false,
  "defaultPenaltyBdt" DECIMAL(12,2) NOT NULL DEFAULT 500,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TradingVolumeTargetSettings_pkey" PRIMARY KEY ("businessId")
);

CREATE UNIQUE INDEX "TradingDailyVolumeTarget_tradingAccountId_targetDate_key" ON "TradingDailyVolumeTarget"("tradingAccountId", "targetDate");
CREATE INDEX "TradingDailyVolumeTarget_businessId_targetDate_idx" ON "TradingDailyVolumeTarget"("businessId", "targetDate");
CREATE INDEX "TradingDailyVolumeTarget_businessId_status_targetDate_idx" ON "TradingDailyVolumeTarget"("businessId", "status", "targetDate");
CREATE INDEX "TradingVolumeTargetPenalty_businessId_status_createdAt_idx" ON "TradingVolumeTargetPenalty"("businessId", "status", "createdAt");
CREATE INDEX "TradingVolumeTargetAudit_businessId_action_createdAt_idx" ON "TradingVolumeTargetAudit"("businessId", "action", "createdAt");

ALTER TABLE "TradingDailyVolumeTarget" ADD CONSTRAINT "TradingDailyVolumeTarget_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradingVolumeTargetPenalty" ADD CONSTRAINT "TradingVolumeTargetPenalty_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TradingDailyVolumeTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TradingVolumeTargetAudit" ADD CONSTRAINT "TradingVolumeTargetAudit_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TradingDailyVolumeTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
