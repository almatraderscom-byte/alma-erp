-- CreateTable
CREATE TABLE "LifestyleExpense" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "subCat" TEXT,
    "expType" TEXT,
    "title" TEXT,
    "description" TEXT,
    "vendor" TEXT,
    "amount" INTEGER NOT NULL,
    "paymentMethod" TEXT,
    "paymentStatus" TEXT,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "receiptRef" TEXT,
    "attachmentId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "legacySheetId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'erp',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifestyleExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LifestyleExpense_legacySheetId_key" ON "LifestyleExpense"("legacySheetId");

-- CreateIndex
CREATE INDEX "LifestyleExpense_businessId_deletedAt_expenseDate_idx" ON "LifestyleExpense"("businessId", "deletedAt", "expenseDate" DESC);

-- CreateIndex
CREATE INDEX "LifestyleExpense_businessId_category_idx" ON "LifestyleExpense"("businessId", "category");

-- CreateIndex
CREATE INDEX "LifestyleExpense_businessId_expType_idx" ON "LifestyleExpense"("businessId", "expType");

