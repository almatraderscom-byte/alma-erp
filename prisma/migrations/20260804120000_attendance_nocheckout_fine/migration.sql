-- Attendance no-checkout fine (Step 2): owner-approved 500৳ penalty for a day
-- the staff checked in but never checked out. The fine is NEVER automatic — a
-- nightly sweep raises an approval to the owner, and only an APPROVE posts the
-- ledger entry recorded in these columns.
-- Additive only — safe to run on production before the feature is enabled.

ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "noCheckoutFineAmount" DECIMAL(12,2);
ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "noCheckoutFineLedgerEntryId" TEXT;
