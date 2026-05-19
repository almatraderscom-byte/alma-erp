ALTER TABLE "TradingPerformanceScreenshot"
  ADD COLUMN IF NOT EXISTS "employeeId" TEXT,
  ADD COLUMN IF NOT EXISTS "driveFileId" TEXT,
  ADD COLUMN IF NOT EXISTS "driveFolderId" TEXT,
  ADD COLUMN IF NOT EXISTS "previewUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "expiryDate" TIMESTAMP(3);

UPDATE "TradingPerformanceScreenshot"
SET
  "driveFileId" = COALESCE(NULLIF("driveFileId", ''), "objectPath"),
  "previewUrl" = COALESCE(NULLIF("previewUrl", ''), NULL),
  "expiryDate" = COALESCE("expiryDate", "shotDate" + INTERVAL '30 days')
WHERE "driveFileId" IS NULL OR "expiryDate" IS NULL;

ALTER TABLE "TradingPerformanceScreenshot"
  ALTER COLUMN "driveFileId" SET NOT NULL,
  ALTER COLUMN "expiryDate" SET NOT NULL;

-- Preserve legacy Supabase storage metadata for audit/history.
-- Prisma no longer reads these columns, but dropping them would be destructive.

CREATE INDEX IF NOT EXISTS "TradingPerformanceScreenshot_businessId_expiryDate_idx"
  ON "TradingPerformanceScreenshot"("businessId", "expiryDate");
CREATE INDEX IF NOT EXISTS "TradingPerformanceScreenshot_driveFileId_idx"
  ON "TradingPerformanceScreenshot"("driveFileId");
CREATE INDEX IF NOT EXISTS "TradingPerformanceScreenshot_employeeId_idx"
  ON "TradingPerformanceScreenshot"("employeeId");
