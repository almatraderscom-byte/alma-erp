-- Attendance exception / permission (Step 3): a staff requests a one-click
-- waiver of the day's attendance rules; the owner approves and the checkout
-- gates + no-checkout fine are skipped for that staff that day. Optional hour
-- window narrows the waiver. Additive only — safe before the feature is on.

DO $$ BEGIN
  CREATE TYPE "AttendanceExceptionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "AttendanceException" (
  "id"             TEXT NOT NULL,
  "businessId"     TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "employeeId"     TEXT NOT NULL,
  "attendanceDate" TIMESTAMP(3) NOT NULL,
  "status"         "AttendanceExceptionStatus" NOT NULL DEFAULT 'PENDING',
  "startMinutes"   INTEGER,
  "endMinutes"     INTEGER,
  "reason"         TEXT NOT NULL,
  "grantedDirect"  BOOLEAN NOT NULL DEFAULT false,
  "adminNote"      TEXT,
  "reviewedById"   TEXT,
  "reviewedAt"     TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AttendanceException_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AttendanceException_businessId_userId_attendanceDate_key"
  ON "AttendanceException" ("businessId", "userId", "attendanceDate");
CREATE INDEX IF NOT EXISTS "AttendanceException_businessId_attendanceDate_idx"
  ON "AttendanceException" ("businessId", "attendanceDate");
CREATE INDEX IF NOT EXISTS "AttendanceException_businessId_status_attendanceDate_idx"
  ON "AttendanceException" ("businessId", "status", "attendanceDate");
CREATE INDEX IF NOT EXISTS "AttendanceException_businessId_employeeId_attendanceDate_idx"
  ON "AttendanceException" ("businessId", "employeeId", "attendanceDate");
