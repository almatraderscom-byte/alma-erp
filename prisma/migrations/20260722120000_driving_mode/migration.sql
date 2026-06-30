-- CreateTable
CREATE TABLE "DrivingModeProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DrivingModeProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrivingModeSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "staffId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "initiatedBy" TEXT NOT NULL DEFAULT 'staff',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,
    "approvalId" TEXT,
    "reviewedById" TEXT,
    "welcomeBackSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DrivingModeSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DrivingModeProfile_businessId_idx" ON "DrivingModeProfile"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "DrivingModeProfile_userId_businessId_key" ON "DrivingModeProfile"("userId", "businessId");

-- CreateIndex
CREATE INDEX "DrivingModeSession_userId_businessId_status_idx" ON "DrivingModeSession"("userId", "businessId", "status");

-- CreateIndex
CREATE INDEX "DrivingModeSession_businessId_status_idx" ON "DrivingModeSession"("businessId", "status");

-- CreateIndex
CREATE INDEX "DrivingModeSession_staffId_status_idx" ON "DrivingModeSession"("staffId", "status");

-- AddForeignKey
ALTER TABLE "DrivingModeProfile" ADD CONSTRAINT "DrivingModeProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrivingModeSession" ADD CONSTRAINT "DrivingModeSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
