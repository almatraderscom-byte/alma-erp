-- Attendance checkout-discipline (Step 1): record GPS captured at check-OUT,
-- separate from the existing check-in location columns. Audit trail so a fine
-- appeal can verify where the staff was when they ended work.
-- Additive only — safe to run on production before the feature is enabled.

ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "checkOutLatitude" DECIMAL(10,7);
ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "checkOutLongitude" DECIMAL(10,7);
ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "checkOutLocationAccuracyM" INTEGER;
ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "checkOutDistanceFromOfficeM" INTEGER;
