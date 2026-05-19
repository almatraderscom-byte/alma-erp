-- Add transactional SMS delivery logs.
CREATE TABLE "SmsLog" (
  "id" TEXT NOT NULL,
  "businessId" TEXT,
  "phone" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'sms.net.bd',
  "requestId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "metadataJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SmsLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SmsLog_createdAt_idx" ON "SmsLog"("createdAt");
CREATE INDEX "SmsLog_phone_idx" ON "SmsLog"("phone");
CREATE INDEX "SmsLog_status_idx" ON "SmsLog"("status");
CREATE INDEX "SmsLog_businessId_idx" ON "SmsLog"("businessId");
CREATE INDEX "SmsLog_businessId_type_phone_createdAt_idx" ON "SmsLog"("businessId", "type", "phone", "createdAt");
CREATE INDEX "SmsLog_requestId_idx" ON "SmsLog"("requestId");

CREATE TABLE "SmsSetting" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "senderId" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SmsSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SmsSetting_businessId_key" ON "SmsSetting"("businessId");
CREATE INDEX "SmsSetting_enabled_idx" ON "SmsSetting"("enabled");
