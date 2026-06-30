-- Add a purpose/scope to attendance exceptions so a late-arrival waiver does
-- not also unlock an early checkout. Additive, safe default for existing rows.
ALTER TABLE "AttendanceException"
  ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'FULL_DAY';
