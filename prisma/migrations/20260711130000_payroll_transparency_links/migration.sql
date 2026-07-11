-- Payroll transparency: direct fine <-> appeal <-> refund joins (additive only)

-- Refund/settlement entries can point at the original entry they settle
ALTER TABLE "EmployeeLedgerEntry" ADD COLUMN "relatedEntryId" TEXT;
CREATE INDEX "EmployeeLedgerEntry_relatedEntryId_idx" ON "EmployeeLedgerEntry"("relatedEntryId");

-- Appeals can point at the PENALTY ledger entry they contest
ALTER TABLE "AttendanceWaiverRequest" ADD COLUMN "penaltyLedgerEntryId" TEXT;
CREATE INDEX "AttendanceWaiverRequest_penaltyLedgerEntryId_idx" ON "AttendanceWaiverRequest"("penaltyLedgerEntryId");
