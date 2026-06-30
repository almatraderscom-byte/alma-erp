-- CreateTable
CREATE TABLE "OfficeFundEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfficeFundEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfficeFundEntry_businessId_deletedAt_createdAt_idx" ON "OfficeFundEntry"("businessId", "deletedAt", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OfficeFundEntry_businessId_type_idx" ON "OfficeFundEntry"("businessId", "type");

-- CreateIndex
CREATE INDEX "OfficeFundEntry_refType_refId_idx" ON "OfficeFundEntry"("refType", "refId");
