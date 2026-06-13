-- Revert global schema defaults; ALMA_LIFESTYLE hours are per-business in officeHoursFor()
ALTER TABLE "AttendanceRecord" ALTER COLUMN "officeStartMinutes" SET DEFAULT 540;
ALTER TABLE "AttendanceRecord" ALTER COLUMN "officeEndMinutes" SET DEFAULT 1260;
ALTER TABLE "TelegramOpsSetting" ALTER COLUMN "officeStartMinutes" SET DEFAULT 540;
