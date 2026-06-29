-- Advance-salary wallet flow:
--   ADVANCE_DISBURSEMENT (credit) = approved advance money credited INTO the wallet (raises withdrawable).
--   ADVANCE_RECOVERY    (debit)  = auto-deducted from the next month's salary accrual until the advance is cleared.

-- AlterEnum
ALTER TYPE "EmployeeLedgerEntryType" ADD VALUE IF NOT EXISTS 'ADVANCE_DISBURSEMENT';
ALTER TYPE "EmployeeLedgerEntryType" ADD VALUE IF NOT EXISTS 'ADVANCE_RECOVERY';

-- CreateTable
CREATE TABLE "AdvanceNoticeAck" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "ackDate" TEXT NOT NULL,
    "outstandingAtAck" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvanceNoticeAck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceNoticeAck_userId_businessId_ackDate_key" ON "AdvanceNoticeAck"("userId", "businessId", "ackDate");

-- CreateIndex
CREATE INDEX "AdvanceNoticeAck_employeeId_businessId_idx" ON "AdvanceNoticeAck"("employeeId", "businessId");
