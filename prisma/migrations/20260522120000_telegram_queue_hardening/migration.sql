-- Telegram queue production hardening (processing timestamps + claim index)
ALTER TABLE "TelegramNotificationQueue" ADD COLUMN IF NOT EXISTS "processingStartedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "TelegramNotificationQueue_status_processingStartedAt_idx"
  ON "TelegramNotificationQueue"("status", "processingStartedAt");
