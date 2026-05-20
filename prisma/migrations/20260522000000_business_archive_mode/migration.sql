-- Business Archive Mode (soft archive only)
CREATE TYPE "BusinessArchiveBatchStatus" AS ENUM ('PREVIEW', 'COMPLETED', 'RESTORED', 'PARTIAL');

CREATE TABLE "BusinessArchiveBatch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "moduleKeys" TEXT NOT NULL,
    "status" "BusinessArchiveBatchStatus" NOT NULL DEFAULT 'PREVIEW',
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "dryRunSnapshot" TEXT,
    "confirmationPhrase" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "BusinessArchiveBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessArchiveEntity" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "isArchived" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedById" TEXT NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "restoredById" TEXT,

    CONSTRAINT "BusinessArchiveEntity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessArchiveAuditLog" (
    "id" TEXT NOT NULL,
    "batchId" TEXT,
    "businessId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "detailJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessArchiveAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessArchiveEntity_businessId_moduleKey_entityId_key" ON "BusinessArchiveEntity"("businessId", "moduleKey", "entityId");
CREATE INDEX "BusinessArchiveBatch_businessId_createdAt_idx" ON "BusinessArchiveBatch"("businessId", "createdAt");
CREATE INDEX "BusinessArchiveBatch_status_createdAt_idx" ON "BusinessArchiveBatch"("status", "createdAt");
CREATE INDEX "BusinessArchiveEntity_batchId_idx" ON "BusinessArchiveEntity"("batchId");
CREATE INDEX "BusinessArchiveEntity_businessId_moduleKey_isArchived_idx" ON "BusinessArchiveEntity"("businessId", "moduleKey", "isArchived");
CREATE INDEX "BusinessArchiveAuditLog_businessId_createdAt_idx" ON "BusinessArchiveAuditLog"("businessId", "createdAt");
CREATE INDEX "BusinessArchiveAuditLog_batchId_createdAt_idx" ON "BusinessArchiveAuditLog"("batchId", "createdAt");

ALTER TABLE "BusinessArchiveEntity" ADD CONSTRAINT "BusinessArchiveEntity_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BusinessArchiveBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Soft archive columns (Prisma-managed tables)
ALTER TABLE "ApprovalRequest" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ApprovalRequest" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "ApprovalRequest" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "ApprovalRequest" ADD COLUMN "archiveBatchId" TEXT;

ALTER TABLE "AttendanceRecord" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AttendanceRecord" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "AttendanceRecord" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "AttendanceRecord" ADD COLUMN "archiveBatchId" TEXT;

ALTER TABLE "AttendanceWaiverRequest" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AttendanceWaiverRequest" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "AttendanceWaiverRequest" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "AttendanceWaiverRequest" ADD COLUMN "archiveBatchId" TEXT;

ALTER TABLE "TradingTrade" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TradingTrade" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "TradingTrade" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "TradingTrade" ADD COLUMN "archiveBatchId" TEXT;

ALTER TABLE "TradingExpense" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TradingExpense" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "TradingExpense" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "TradingExpense" ADD COLUMN "archiveBatchId" TEXT;

ALTER TABLE "TradingTelegramDraft" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TradingTelegramDraft" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "TradingTelegramDraft" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "TradingTelegramDraft" ADD COLUMN "archiveBatchId" TEXT;

ALTER TABLE "InvoiceRecord" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InvoiceRecord" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "InvoiceRecord" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "InvoiceRecord" ADD COLUMN "archiveBatchId" TEXT;

ALTER TABLE "WalletRequest" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WalletRequest" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "WalletRequest" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "WalletRequest" ADD COLUMN "archiveBatchId" TEXT;

ALTER TABLE "EmployeeLedgerEntry" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmployeeLedgerEntry" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "EmployeeLedgerEntry" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "EmployeeLedgerEntry" ADD COLUMN "archiveBatchId" TEXT;

CREATE INDEX "ApprovalRequest_businessId_isArchived_createdAt_idx" ON "ApprovalRequest"("businessId", "isArchived", "createdAt");
CREATE INDEX "AttendanceRecord_businessId_isArchived_attendanceDate_idx" ON "AttendanceRecord"("businessId", "isArchived", "attendanceDate");
CREATE INDEX "AttendanceWaiverRequest_businessId_isArchived_createdAt_idx" ON "AttendanceWaiverRequest"("businessId", "isArchived", "createdAt");
CREATE INDEX "TradingTrade_businessId_isArchived_tradeDate_idx" ON "TradingTrade"("businessId", "isArchived", "tradeDate");
CREATE INDEX "TradingExpense_businessId_isArchived_expenseDate_idx" ON "TradingExpense"("businessId", "isArchived", "expenseDate");
CREATE INDEX "TradingTelegramDraft_businessId_isArchived_createdAt_idx" ON "TradingTelegramDraft"("businessId", "isArchived", "createdAt");
CREATE INDEX "InvoiceRecord_businessId_isArchived_createdAt_idx" ON "InvoiceRecord"("businessId", "isArchived", "createdAt");
CREATE INDEX "WalletRequest_businessId_isArchived_createdAt_idx" ON "WalletRequest"("businessId", "isArchived", "createdAt");
CREATE INDEX "EmployeeLedgerEntry_businessId_isArchived_createdAt_idx" ON "EmployeeLedgerEntry"("businessId", "isArchived", "createdAt");
