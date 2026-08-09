ALTER TABLE "User"
  ADD COLUMN "offboardedAt" TIMESTAMP(3),
  ADD COLUMN "hrOffboardedAt" TIMESTAMP(3),
  ADD COLUMN "offboardedBy" TEXT,
  ADD COLUMN "offboardingReason" TEXT;

CREATE INDEX "User_offboardedAt_idx" ON "User"("offboardedAt");
