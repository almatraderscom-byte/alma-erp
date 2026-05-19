-- CreateEnum
CREATE TYPE "TelegramNotificationStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TelegramNotificationEventType" AS ENUM (
  'ATTENDANCE_CHECK_IN',
  'ATTENDANCE_CHECK_OUT',
  'ATTENDANCE_ABSENT',
  'ATTENDANCE_NO_CHECKOUT',
  'ATTENDANCE_EARLY_LEAVE',
  'ATTENDANCE_SUSPICIOUS',
  'ATTENDANCE_WAIVER_SUBMITTED',
  'ATTENDANCE_WAIVER_REVIEWED',
  'TRADING_SCREENSHOT_UPLOAD',
  'TRADING_SCREENSHOT_FAILURE',
  'TRADING_DELETE_REQUEST',
  'TRADING_SUSPICIOUS',
  'OPS_DAILY_SUMMARY'
);

-- CreateTable
CREATE TABLE "TelegramNotificationQueue" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "eventType" "TelegramNotificationEventType" NOT NULL,
    "dedupeKey" TEXT,
    "message" TEXT NOT NULL,
    "status" "TelegramNotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramNotificationQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramOpsSetting" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ownerChatIds" TEXT NOT NULL DEFAULT '',
    "officeStartMinutes" INTEGER NOT NULL DEFAULT 540,
    "gracePeriodMinutes" INTEGER NOT NULL DEFAULT 15,
    "checkoutCutoffMinutes" INTEGER NOT NULL DEFAULT 1320,
    "earlyLeaveMinutes" INTEGER NOT NULL DEFAULT 360,
    "alertAttendanceCheckIn" BOOLEAN NOT NULL DEFAULT true,
    "alertAttendanceLate" BOOLEAN NOT NULL DEFAULT true,
    "alertAttendanceAbsent" BOOLEAN NOT NULL DEFAULT true,
    "alertAttendanceCheckOut" BOOLEAN NOT NULL DEFAULT true,
    "alertAttendanceNoCheckout" BOOLEAN NOT NULL DEFAULT true,
    "alertAttendanceEarlyLeave" BOOLEAN NOT NULL DEFAULT true,
    "alertAttendanceSuspicious" BOOLEAN NOT NULL DEFAULT true,
    "alertTradingScreenshot" BOOLEAN NOT NULL DEFAULT true,
    "alertTradingDeleteRequest" BOOLEAN NOT NULL DEFAULT true,
    "alertOpsDailySummary" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramOpsSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramOpsAuditLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "employeeId" TEXT,
    "attendanceRecordId" TEXT,
    "detail" TEXT,
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramOpsAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramNotificationQueue_dedupeKey_key" ON "TelegramNotificationQueue"("dedupeKey");

-- CreateIndex
CREATE INDEX "TelegramNotificationQueue_status_nextAttemptAt_createdAt_idx" ON "TelegramNotificationQueue"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "TelegramNotificationQueue_businessId_createdAt_idx" ON "TelegramNotificationQueue"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "TelegramNotificationQueue_eventType_createdAt_idx" ON "TelegramNotificationQueue"("eventType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramOpsSetting_businessId_key" ON "TelegramOpsSetting"("businessId");

-- CreateIndex
CREATE INDEX "TelegramOpsSetting_enabled_idx" ON "TelegramOpsSetting"("enabled");

-- CreateIndex
CREATE INDEX "TelegramOpsAuditLog_businessId_eventType_createdAt_idx" ON "TelegramOpsAuditLog"("businessId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "TelegramOpsAuditLog_employeeId_createdAt_idx" ON "TelegramOpsAuditLog"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "TelegramOpsAuditLog_attendanceRecordId_idx" ON "TelegramOpsAuditLog"("attendanceRecordId");
