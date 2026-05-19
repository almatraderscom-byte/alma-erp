-- CreateEnum
CREATE TYPE "AttendanceTrustStatus" AS ENUM ('TRUSTED', 'WARNING', 'REQUIRES_VERIFICATION');

-- AlterTable
ALTER TABLE "AttendanceRecord"
ADD COLUMN "browserFingerprint" TEXT,
ADD COLUMN "deviceKey" TEXT,
ADD COLUMN "sessionId" TEXT,
ADD COLUMN "latitude" DECIMAL(10,7),
ADD COLUMN "longitude" DECIMAL(10,7),
ADD COLUMN "locationAccuracyM" INTEGER,
ADD COLUMN "distanceFromOfficeM" INTEGER,
ADD COLUMN "trustStatus" "AttendanceTrustStatus" NOT NULL DEFAULT 'TRUSTED',
ADD COLUMN "suspiciousReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "verificationRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "verificationRequestedById" TEXT;

-- CreateTable
CREATE TABLE "AttendanceSelfieVerification" (
    "id" TEXT NOT NULL,
    "attendanceRecordId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceKey" TEXT,
    "imageDataUrl" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'image/jpeg',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceSelfieVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceRecord_businessId_trustStatus_attendanceDate_idx" ON "AttendanceRecord"("businessId", "trustStatus", "attendanceDate");

-- CreateIndex
CREATE INDEX "AttendanceRecord_businessId_verificationRequired_attendanceDate_idx" ON "AttendanceRecord"("businessId", "verificationRequired", "attendanceDate");

-- CreateIndex
CREATE INDEX "AttendanceRecord_businessId_employeeId_deviceKey_idx" ON "AttendanceRecord"("businessId", "employeeId", "deviceKey");

-- CreateIndex
CREATE INDEX "AttendanceSelfieVerification_businessId_capturedAt_idx" ON "AttendanceSelfieVerification"("businessId", "capturedAt");

-- CreateIndex
CREATE INDEX "AttendanceSelfieVerification_businessId_employeeId_capturedAt_idx" ON "AttendanceSelfieVerification"("businessId", "employeeId", "capturedAt");

-- CreateIndex
CREATE INDEX "AttendanceSelfieVerification_attendanceRecordId_capturedAt_idx" ON "AttendanceSelfieVerification"("attendanceRecordId", "capturedAt");

-- CreateIndex
CREATE INDEX "AttendanceSelfieVerification_userId_idx" ON "AttendanceSelfieVerification"("userId");

-- AddForeignKey
ALTER TABLE "AttendanceSelfieVerification" ADD CONSTRAINT "AttendanceSelfieVerification_attendanceRecordId_fkey" FOREIGN KEY ("attendanceRecordId") REFERENCES "AttendanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSelfieVerification" ADD CONSTRAINT "AttendanceSelfieVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
