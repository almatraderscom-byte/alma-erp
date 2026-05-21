-- Phase 1 Sheets→Postgres migration: indexes that close the two hot-query gaps
-- discovered by the read-only audit (docs/MIGRATION.md → Phase 1).
--
-- Index 1: AttendanceRecord(businessId, checkInAt)
--   Backs /api/attendance/check-in/health range scans
--   (prisma.attendanceRecord.findMany where: { businessId, checkInAt: { gte: cutoff } }).
--   The existing (businessId, attendanceDate) index does NOT cover checkInAt range filters.
--
-- Index 2: TelegramNotificationQueue(status, updatedAt)
--   Backs reclaimStuckTelegramSendingRows + the stuck-SENDING count probe
--   (where: { status: 'SENDING', updatedAt: { lt: cutoff } }). Existing index is on
--   processingStartedAt, which is null for legacy rows and not used by the reclaim.

CREATE INDEX IF NOT EXISTS "AttendanceRecord_businessId_checkInAt_idx"
  ON "AttendanceRecord"("businessId", "checkInAt");

CREATE INDEX IF NOT EXISTS "TelegramNotificationQueue_status_updatedAt_idx"
  ON "TelegramNotificationQueue"("status", "updatedAt");
