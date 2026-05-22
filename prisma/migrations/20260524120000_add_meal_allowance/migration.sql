-- AlterEnum
ALTER TYPE "EmployeeLedgerEntryType" ADD VALUE IF NOT EXISTS 'MEAL_ALLOWANCE';

-- CreateTable
CREATE TABLE "MealAllowanceProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "amountBdt" DECIMAL(12,2) NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MealAllowanceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealAllowanceRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "allowanceDate" TIMESTAMP(3) NOT NULL,
    "amountBdt" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "ledgerEntryId" TEXT,
    "reviewedById" TEXT,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MealAllowanceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MealAllowanceProfile_businessId_idx" ON "MealAllowanceProfile"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "MealAllowanceProfile_userId_businessId_key" ON "MealAllowanceProfile"("userId", "businessId");

-- CreateIndex
CREATE INDEX "MealAllowanceRequest_businessId_status_idx" ON "MealAllowanceRequest"("businessId", "status");

-- CreateIndex
CREATE INDEX "MealAllowanceRequest_userId_businessId_idx" ON "MealAllowanceRequest"("userId", "businessId");

-- AddForeignKey
ALTER TABLE "MealAllowanceProfile" ADD CONSTRAINT "MealAllowanceProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealAllowanceRequest" ADD CONSTRAINT "MealAllowanceRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
