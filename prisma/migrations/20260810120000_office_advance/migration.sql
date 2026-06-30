-- CreateTable
CREATE TABLE "OfficeAdvance" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "employeeId" TEXT NOT NULL,
    "userId" TEXT,
    "requestedByName" TEXT,
    "amount" INTEGER NOT NULL,
    "purpose" TEXT,
    "payoutMethod" TEXT,
    "payoutNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "spentAmount" INTEGER,
    "leftoverAmount" INTEGER,
    "leftoverMethod" TEXT,
    "approvalId" TEXT,
    "reconcileApprovalId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficeAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfficeAdvance_businessId_status_createdAt_idx" ON "OfficeAdvance"("businessId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OfficeAdvance_employeeId_status_idx" ON "OfficeAdvance"("employeeId", "status");

-- CreateIndex
CREATE INDEX "OfficeAdvance_userId_status_idx" ON "OfficeAdvance"("userId", "status");
