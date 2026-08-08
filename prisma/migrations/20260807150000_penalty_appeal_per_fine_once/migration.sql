-- Bind appeals to the exact wallet PENALTY row and enforce one appeal per
-- employee/fine. Legacy rows without a ledger link remain readable.
DROP INDEX IF EXISTS "AttendanceWaiverRequest_attendanceRecordId_userId_key";

CREATE INDEX IF NOT EXISTS "AttendanceWaiverRequest_attendanceRecordId_userId_idx"
  ON "AttendanceWaiverRequest"("attendanceRecordId", "userId");

CREATE UNIQUE INDEX IF NOT EXISTS "AttendanceWaiverRequest_penaltyLedgerEntryId_userId_key"
  ON "AttendanceWaiverRequest"("penaltyLedgerEntryId", "userId")
  WHERE "penaltyLedgerEntryId" IS NOT NULL;
