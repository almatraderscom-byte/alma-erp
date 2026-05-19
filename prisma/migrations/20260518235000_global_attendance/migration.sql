-- CreateEnum
CREATE TYPE "AttendanceRecordStatus" AS ENUM ('PRESENT', 'LATE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AttendanceWaiverStatus" AS ENUM ('PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "AttendanceRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendanceDate" TIMESTAMP(3) NOT NULL,
    "status" "AttendanceRecordStatus" NOT NULL DEFAULT 'PRESENT',
    "officeStartMinutes" INTEGER NOT NULL DEFAULT 540,
    "officeEndMinutes" INTEGER NOT NULL DEFAULT 1260,
    "checkInAt" TIMESTAMP(3) NOT NULL,
    "checkOutAt" TIMESTAMP(3),
    "totalWorkMinutes" INTEGER NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "penaltyAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "penaltyLedgerEntryId" TEXT,
    "deviceInfo" TEXT,
    "sessionInfo" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceWaiverRequest" (
    "id" TEXT NOT NULL,
    "attendanceRecordId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "AttendanceWaiverStatus" NOT NULL DEFAULT 'PENDING',
    "originalPenaltyAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "requestedReductionAmount" DECIMAL(12,2),
    "approvedReductionAmount" DECIMAL(12,2),
    "reason" TEXT NOT NULL,
    "adminNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reversalLedgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceWaiverRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRecord_businessId_employeeId_attendanceDate_key" ON "AttendanceRecord"("businessId", "employeeId", "attendanceDate");

-- CreateIndex
CREATE INDEX "AttendanceRecord_businessId_attendanceDate_idx" ON "AttendanceRecord"("businessId", "attendanceDate");

-- CreateIndex
CREATE INDEX "AttendanceRecord_businessId_status_attendanceDate_idx" ON "AttendanceRecord"("businessId", "status", "attendanceDate");

-- CreateIndex
CREATE INDEX "AttendanceRecord_businessId_employeeId_attendanceDate_idx" ON "AttendanceRecord"("businessId", "employeeId", "attendanceDate");

-- CreateIndex
CREATE INDEX "AttendanceRecord_businessId_userId_attendanceDate_idx" ON "AttendanceRecord"("businessId", "userId", "attendanceDate");

-- CreateIndex
CREATE INDEX "AttendanceRecord_penaltyLedgerEntryId_idx" ON "AttendanceRecord"("penaltyLedgerEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceWaiverRequest_attendanceRecordId_userId_key" ON "AttendanceWaiverRequest"("attendanceRecordId", "userId");

-- CreateIndex
CREATE INDEX "AttendanceWaiverRequest_businessId_status_createdAt_idx" ON "AttendanceWaiverRequest"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceWaiverRequest_businessId_employeeId_createdAt_idx" ON "AttendanceWaiverRequest"("businessId", "employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceWaiverRequest_businessId_userId_createdAt_idx" ON "AttendanceWaiverRequest"("businessId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceWaiverRequest_reviewedById_idx" ON "AttendanceWaiverRequest"("reviewedById");

-- CreateIndex
CREATE INDEX "AttendanceWaiverRequest_reversalLedgerEntryId_idx" ON "AttendanceWaiverRequest"("reversalLedgerEntryId");

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceWaiverRequest" ADD CONSTRAINT "AttendanceWaiverRequest_attendanceRecordId_fkey" FOREIGN KEY ("attendanceRecordId") REFERENCES "AttendanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceWaiverRequest" ADD CONSTRAINT "AttendanceWaiverRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceWaiverRequest" ADD CONSTRAINT "AttendanceWaiverRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
