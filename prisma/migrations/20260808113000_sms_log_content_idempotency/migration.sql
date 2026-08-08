-- A deterministic content id makes event SMS creation concurrency-safe. The
-- nullable unique column preserves existing ad-hoc/cooldown-based SMS rows.
ALTER TABLE "SmsLog" ADD COLUMN "contentId" TEXT;
CREATE UNIQUE INDEX "SmsLog_contentId_key" ON "SmsLog"("contentId");
