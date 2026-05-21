-- Performance: telegram queue drain + attendance user lookups
CREATE INDEX IF NOT EXISTS "TelegramNotificationQueue_status_attempts_nextAttemptAt_idx"
  ON "TelegramNotificationQueue"("status", "attempts", "nextAttemptAt");

CREATE INDEX IF NOT EXISTS "AttendanceRecord_userId_attendanceDate_idx"
  ON "AttendanceRecord"("userId", "attendanceDate");
