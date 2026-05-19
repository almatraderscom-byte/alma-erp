-- Penalty appeal / reduction request workflow
CREATE TYPE "AttendanceWaiverRequestType" AS ENUM ('FULL_WAIVE', 'PARTIAL_REDUCE', 'RECONSIDERATION');

ALTER TYPE "AttendanceWaiverStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "AttendanceWaiverRequest"
  ADD COLUMN IF NOT EXISTS "requestType" "AttendanceWaiverRequestType" NOT NULL DEFAULT 'FULL_WAIVE',
  ADD COLUMN IF NOT EXISTS "attachmentDataUrl" TEXT;
