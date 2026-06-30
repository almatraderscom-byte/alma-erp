-- Attendance leave application (Step 4): staff applies for leave (single day,
-- date range, hours, or shifted start) and the owner approves. While approved
-- leave covers a day, the checkout gates are waived and fines do not apply.
-- Additive only — safe to run on production before the feature is enabled.

DO $$ BEGIN
  CREATE TYPE "AttendanceLeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "AttendanceLeaveKind" AS ENUM ('FULL_DAY', 'DATE_RANGE', 'HOURS', 'SHIFTED_START');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "AttendanceLeave" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "employeeId"    TEXT NOT NULL,
  "kind"          "AttendanceLeaveKind" NOT NULL DEFAULT 'FULL_DAY',
  "startDate"     TIMESTAMP(3) NOT NULL,
  "endDate"       TIMESTAMP(3) NOT NULL,
  "startMinutes"  INTEGER,
  "endMinutes"    INTEGER,
  "status"        "AttendanceLeaveStatus" NOT NULL DEFAULT 'PENDING',
  "reason"        TEXT NOT NULL,
  "grantedDirect" BOOLEAN NOT NULL DEFAULT false,
  "adminNote"     TEXT,
  "reviewedById"  TEXT,
  "reviewedAt"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AttendanceLeave_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AttendanceLeave_businessId_userId_startDate_idx"
  ON "AttendanceLeave" ("businessId", "userId", "startDate");
CREATE INDEX IF NOT EXISTS "AttendanceLeave_businessId_status_startDate_idx"
  ON "AttendanceLeave" ("businessId", "status", "startDate");
CREATE INDEX IF NOT EXISTS "AttendanceLeave_businessId_employeeId_startDate_idx"
  ON "AttendanceLeave" ("businessId", "employeeId", "startDate");
