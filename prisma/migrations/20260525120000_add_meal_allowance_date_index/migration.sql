-- CreateIndex
CREATE INDEX "MealAllowanceRequest_userId_businessId_allowanceDate_idx" ON "MealAllowanceRequest"("userId", "businessId", "allowanceDate");
