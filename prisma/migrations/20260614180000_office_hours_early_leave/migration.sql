-- Office hours 9:30–20:00 + early checkout penalty fields
ALTER TYPE "AttendanceRecordStatus" ADD VALUE IF NOT EXISTS 'EARLY_LEAVE';

ALTER TABLE "AttendanceRecord"
  ADD COLUMN IF NOT EXISTS "earlyLeaveMinutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "earlyLeavePenaltyAmount" DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "earlyLeavePenaltyLedgerEntryId" TEXT;

ALTER TABLE "AttendanceRecord" ALTER COLUMN "officeStartMinutes" SET DEFAULT 570;
ALTER TABLE "AttendanceRecord" ALTER COLUMN "officeEndMinutes" SET DEFAULT 1200;
ALTER TABLE "TelegramOpsSetting" ALTER COLUMN "officeStartMinutes" SET DEFAULT 570;

UPDATE "TelegramOpsSetting"
SET "officeStartMinutes" = 570
WHERE "businessId" = 'ALMA_LIFESTYLE' AND "officeStartMinutes" = 540;
